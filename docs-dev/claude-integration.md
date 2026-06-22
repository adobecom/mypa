# Claude Integration

All AI work in mypa goes through `src/main/services/agent.ts`, which uses `@anthropic-ai/claude-agent-sdk` directly. There is no subprocess spawn — the SDK is called in-process. `src/main/services/claude.ts` provides thin shims that forward to `agent.ts` for backward-compatible call sites.

---

## Binary discovery

`detectClaudeBin(): string | null` (exported from `claude.ts`) is retained for the setup/health IPC handlers. It never throws.

Priority order:

1. `which claude` against the PATH that `fixPath()` patched (covers Homebrew, nvm, npm-global when PATH is correctly inherited or repaired).
2. Static candidate list, checked with `existsSync`, in order:
   - `~/.claude/local/claude` — official installer
   - `~/.npm-global/bin/claude` — default npm global prefix
   - `~/.local/bin/claude`
   - `~/.bun/bin/claude`
   - `~/.nvm/versions/node/<ver>/bin/claude` — all installed nvm node versions, newest first (enumerated from disk via `readdirSync`, no shell)
   - `/opt/homebrew/bin/claude`
   - `/usr/local/bin/claude`
   - `$(npm prefix -g)/bin/claude` — best-effort custom prefix (3 s timeout, never blocks startup)

`path-fix.ts` (`fixPath()`) also enumerates all nvm node-version bin dirs via `nvmBinDirs()` and adds `~/.claude/local`, `~/.npm-global/bin`, `~/.bun/bin`, and `~/.volta/bin` to `process.env.PATH`.

---

## Automatic model selection

mypa selects the Claude model for each task automatically — there is no user-facing model control. The logic lives in `src/main/services/model-router.ts`.

### Tier ladder

| Tier | Model ID |
|---|---|
| fast | `claude-haiku-4-5-20251001` |
| balanced | `claude-sonnet-4-6` |
| capable | `claude-opus-4-8` |

### `selectModel(source, promptChars)`

Maps each `UsageSource` label to a base tier, then bumps the tier up for large prompts:

| source | base tier |
|---|---|
| `inference`, `plan_draft` | fast |
| `routine_digest`, `routine_setup`, `routine_chat`, `plan_chat`, `checkin_chat`, `checkin_extract`, `memory`, `chat`, `other` | balanced |
| `suggest` | capable |

Size bumps (applied after the base tier):
- prompt >= 12 000 chars → +1 tier
- prompt >= 40 000 chars → +2 tiers
- always clamped to `capable`

### `escalate(modelId)`

Returns the next-stronger model in the ladder, or `null` when already at `capable`. Used by `runAgent` and `streamAgentChat` to retry failed/weak tasks with a stronger model.

---

## `agent.ts` — SDK entry point

All AI calls are made through `src/main/services/agent.ts`, which wraps `@anthropic-ai/claude-agent-sdk`.

### `runAgent` — one-shot completion

```ts
export async function runAgent(
  systemPrompt: string,
  userPrompt: string,
  source?: UsageSource,   // default 'other'
  timeoutMs?: number,     // default 120 000 ms
  expectJson?: boolean    // default false
): Promise<string>
```

- Calls the SDK `query()` with `maxTurns: 1`.
- Selects the initial model via `selectModel(source, fullPrompt.length)`.
- After each attempt, `recordUsage(source, model, result)` persists a row in `usage_events`.
- Hard timeout: **120 seconds** (overridable via `timeoutMs`).
- **Automatic escalation:** if the call errors or a JSON-missing response is returned when `expectJson=true`, the call is retried once at the next-stronger tier via `escalate()`. Gives up and rethrows at the top tier.

### `runAgentWithMcp` — one-shot with MCP access

```ts
export async function runAgentWithMcp(
  systemPrompt: string,
  userPrompt: string,
  source?: UsageSource
): Promise<string>
```

One-shot call with live MCP servers wired in via `options.mcpServers`. Uses the connected server list from `mcp.ts`. Falls back to `runAgent` when no servers are connected.

### `streamAgentChat` — streaming multi-turn chat

```ts
export async function streamAgentChat(
  history: ChatMessage[],
  userMessage: string,
  onChunk: (chunk: string) => void,
  onDone:  (fullText: string) => void,
  rawContext?: string,
  streamId?:   string,
  source?:     UsageSource,   // default 'chat'
  enableMcp?:  boolean        // default false
): Promise<void>
```

- Drives a streaming async generator from the SDK.
- When `enableMcp` is `true`, MCP servers are passed via `options.mcpServers`; the system prompt is extended with `MCP_CHAT_SYSTEM_ADDENDUM`.
- Tool call gating is handled in-process via `canUseTool` (see below) rather than an allowlist flag.
- If the stream fails before any output reaches the client, it is retried once at the escalated tier. User-cancelled streams (`'Cancelled'`) and idle-timed-out streams (`'Stream timed out'`) are never retried.

### `cancelAgentChat` — interrupt an active stream

```ts
export function cancelAgentChat(streamId: string): boolean
```

Calls `Query.interrupt()` on the active stream and removes it from the in-memory map. Returns `true` if a stream was found and interrupted. The renderer calls `window.electron.routines.cancelStream(runId)` or `window.electron.plan.cancelStream(itemId)`.

---

## Tool gating — `canUseTool`

`canUseTool` is the SDK callback invoked before each tool call. It decides whether to auto-allow, auto-deny, or gate on user approval.

**Tool name format:** `mcp__<serverKey>__<toolName>`

Rules (applied in order):
1. Server key `mypa_builtin` — always allowed (covers the in-process `ask_user` tool).
2. Read-only prefix auto-allow: tool names starting with `get`, `list`, `search`, `read`, `fetch`, `find`, `describe`, `view`, `show`, `check`, `query`, `inspect` are allowed immediately.
3. All other (write) tools — `canUseTool` broadcasts `chat:tool-approval-request` to the renderer with a `PendingToolApproval` object and then **awaits** resolution. The stream genuinely blocks until `resolveToolApproval()` is called.

### `resolveToolApproval(approvalId, allow, editedInput?)`

```ts
export function resolveToolApproval(
  approvalId: string,
  allow: boolean,
  editedInput?: Record<string, unknown>
): void
```

Resolves a pending approval: unblocks `canUseTool` with either allowed (passing `editedInput` if provided) or denied. Called by the `chat:resolve-tool-approval` IPC handler.

---

## `ask_user` tool — blocking user questions

When the model needs a clarifying answer, it calls the in-process `ask_user` MCP tool (registered via `buildAskUserServer(streamId)`).

**Tool input:** `{ prompt: string, options: string[], multiSelect?: boolean }`

**Flow:**
1. `ask_user` handler broadcasts `chat:ask-question` to the renderer with a `PendingQuestion` object.
2. The renderer shows clickable option chips.
3. The stream genuinely blocks until `resolveQuestion(questionId, answer)` is called.
4. Calling `window.electron.chat.answerQuestion(questionId, answer)` from the renderer unblocks the stream.

This prevents the "No answer selected" bug — the turn truly blocks rather than continuing with a missing answer.

### `resolveQuestion(questionId, answer)`

```ts
export function resolveQuestion(questionId: string, answer: string): void
```

Unblocks a pending `ask_user` invocation with the user's chosen answer. Called by the `chat:answer-question` IPC handler.

---

## `claude.ts` — shim layer

`src/main/services/claude.ts` is now a thin forwarding layer. The subprocess-spawn code has been removed.

| Old export | Now delegates to |
|---|---|
| `runClaude(...)` | `runAgent(...)` in `agent.ts` |
| `streamChat(...)` | `streamAgentChat(...)` in `agent.ts` |
| `cancelStream(streamId)` | `cancelAgentChat(streamId)` in `agent.ts` |
| `detectClaudeBin()` | Still implemented here; used by setup/health IPC handlers |

`runClaudeWithMcp` delegates to `runAgentWithMcp` in `agent.ts`.

---

## Generator helpers

### `generatePlanDraft(intent)`

Parses a free-text intent into a `PlanDraft`. Uses `runAgent` with a JSON-only system prompt. Includes the current time and hour so Claude can infer appropriate `timing` values.

Returns:
```ts
{ title, detail, timing: PlanItemTiming, actions: McpActionRef[], original_intent }
```

Falls back gracefully: if Claude's output doesn't contain a JSON object, throws. If fields are missing, defaults are applied (`timing → 'anytime'`, `actions → []`).

### `generateRoutineDigest(name, promptTemplate, rawOutput)`

Summarizes MCP tool outputs for a routine run. Uses `runAgent` with a 240 s timeout.

Returns:
```ts
{ summary: string, body: string }
```

- `summary` — one-sentence headline (max ~120 chars), used as the OS notification body and run-row preview.
- `body` — full markdown digest following the routine's prompt instructions.

The model is instructed to respond in the format:
```
SUMMARY: <one-sentence headline>

<full markdown body>
```

**On failure:** logs the error and returns `{ summary: 'Could not generate digest', body: 'The digest could not be generated. Reason: <message>. ...' }`. Never returns the silent `<name> completed` placeholder.

### `generateRoutineSetup(intent, servers)`

Converts a natural-language routine description + the live MCP tool catalog into a validated `RoutineSetupDraft`.

- Builds a `toolCatalog` string from connected `McpServerStatus[]` (only connected servers with >= 1 tool).
- After parsing Claude's JSON response, **validates** the result:
  - Strips any `actions` entries whose `server::tool` pair isn't in the live catalog.
  - Validates the `cron` expression with `node-cron.validate()`.
- Returns `{ name, actions, prompt, cron? }` — `cron` is `undefined` if Claude produced an invalid expression.

---

## Persona

The persona string from `readConfig().persona` is injected into every system prompt:

```
You are {persona}.
```

Default (if unset or empty): `"a personal assistant"`.

## Owner identity clause

When the user has configured `AppConfig.owner` (name + per-surface handles), every system prompt also receives an owner-identity instruction via `buildOwnerClause()` (`config.ts`):

```
The person you assist is {name}. They appear across connected surfaces under these handles —
github: {handle}, slack: {handle}, …
When activity references any of those handles, that is {name} themselves — address them in the
second person ("you"), never in the third person or by their handle.
```

This clause is appended in: `generateRoutineDigest`, `streamAgentChat`, `generatePlanDraft` (all in `claude.ts`), `inferIntent` (`inference.ts`), and `runMemorySummarization` (`memories.ts`). Returns `''` when owner is not configured.

### Standing directives clause (`buildDirectivesClause`)

When the user has hard memories (learned during check-ins with `enforcement = 'hard'`), every inference system prompt also receives a standing-directives block via `buildDirectivesClause()` (`config.ts`):

```
Standing rules you must always obey (set by the user in past check-ins):
  - <rule 1>
  - <rule 2>
If a candidate observation or proposed action would violate any of the above, do not surface it — return the "nothing actionable" response instead.
```

This clause is appended in `inferIntent` (`inference.ts`) after `buildOwnerClause()`. Re-read at every call (not cached), so newly-added hard rules take effect on the next inference cycle. Returns `''` when there are no hard memories.

## Usage recording

`src/main/services/usage.ts` provides the `recordUsage(source, model, result)` function imported by `agent.ts`. It calls `dbInsertUsage()` and swallows all errors so telemetry never disrupts an AI call.

`UsageSource` labels: `'plan_draft'`, `'routine_digest'`, `'routine_setup'`, `'routine_chat'`, `'plan_chat'`, `'checkin_chat'`, `'checkin_extract'`, `'inference'`, `'memory'`, `'suggest'`, `'chat'`, `'other'`.

## Packaging

`@anthropic-ai/claude-agent-sdk` platform binaries (e.g. `@anthropic-ai/claude-agent-sdk-darwin-arm64`) must be spawnable from a packaged app. The `package.json` build config includes `**/node_modules/@anthropic-ai/claude-agent-sdk-*/**` in `asarUnpack` so the native binary is extracted from the ASAR archive at install time.

## Changelog

- 2026-06-22 — **Agent SDK migration complete:** replaced `claude` CLI subprocess with `@anthropic-ai/claude-agent-sdk`. All AI calls now go through `src/main/services/agent.ts`. `runClaude`/`streamChat`/`cancelStream` in `claude.ts` are now thin shims delegating to `runAgent`/`streamAgentChat`/`cancelAgentChat`. Removed dead subprocess spawn code. MCP servers are passed via `options.mcpServers` (not `--mcp-config` temp file). `canUseTool` callback gates write tools on user approval by broadcasting `chat:tool-approval-request`; read-only prefixes are auto-allowed. New `ask_user` in-process MCP tool broadcasts `chat:ask-question` to block the stream on user input. New `PendingToolApproval` and `PendingQuestion` interfaces in `src/shared/types.ts`. New `IpcApi.chat` namespace with `resolveToolApproval()` and `answerQuestion()`. SDK platform binary added to `asarUnpack` in `package.json`. Removed `stageChatActionsFromSegment` and `ACTION_BLOCK_RE` from `ambient.ts` (text-sentinel write-action layer, superseded by SDK `canUseTool` gating).

- 2026-06-18 — **Stream idle watchdog:** Added `STREAM_IDLE_TIMEOUT_MS = 120_000` and an idle timer inside the stream path. The timer is armed immediately after spawn and resets on every output chunk; if no output arrives for 120 s, the stream is killed and the promise rejects with `'Stream timed out'`. The escalation loop in `streamChat` treats `'Stream timed out'` as terminal (same as `'Cancelled'`) — no retry.

- 2026-06-19 — **Chat write-action correctness (four fixes):** (1) `MCP_CHAT_SYSTEM_ADDENDUM` rewritten to make the contract explicit — emitting an `<action>` block queues the write, never executes it; the model is told to say "queued for approval" and never imply the write happened. (2) Typed approval: `handleIntentChat` and `handlePlanMessage` detect a short affirmative/dismissal phrase and immediately call `approveChatAction`/`dismissChatAction` without streaming a model turn. (3) Action-state rendered into model history. (4) `github:approve` verb added.

- 2026-06-19 — **Plan-chat action parity:** `handlePlanMessage` now strips `<action>` blocks and surfaces Approve/Dismiss chips. Shared helper `stageChatActionsFromSegment` extracted. DB: `plan_item_threads` gains a `metadata TEXT` column. New IPC channels `plan:approve-chat-action` / `plan:dismiss-chat-action`.

- 2026-06-18 — **Live MCP in streaming chat (`enableMcp`):** `buildMcpInvocation()` helper extracted; `streamChat` gains an optional `enableMcp?: boolean` param; `MCP_CHAT_SYSTEM_ADDENDUM` appended to system prompt when set.

- 2026-06-17 — **Automatic model selection + escalation:** replaced the single user-configured model with `model-router.ts`. `selectModel(source, promptChars)` picks a tier and bumps it for large prompts. `escalate(modelId)` returns the next-stronger tier.

- 2026-06-16 — **Unified claude detection:** replaced the separate detection calls with `detectClaudeBin()` (exported from `claude.ts`).

- 2026-06-15 — **Digest format overhaul:** `RoutineDigest` changed from `{ summary, items, proposed_actions }` to `{ summary, body }`; `generateRoutineDigest` now uses a line-delimited `SUMMARY: <headline>\n\n<markdown body>` format with a 240 s timeout.

- 2026-06-10 — **Standing directives clause:** added `buildDirectivesClause()` to `config.ts`; appended to the `inferIntent` system prompt.

- 2026-06-09 — added `claudeEnv()` helper; both run paths now inject `ANTHROPIC_API_KEY` when `AppConfig.claude.apiKey` is set.

- 2026-06-07 — added owner-identity clause (`buildOwnerClause`) injected into all system prompts.

- 2026-06-06 — initial documentation
