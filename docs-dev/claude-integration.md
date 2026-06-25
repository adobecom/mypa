# Claude Integration

All AI work in mypa goes through `src/main/services/agent.ts`, which uses `@anthropic-ai/claude-agent-sdk` directly. There is no subprocess spawn — the SDK is called in-process. `src/main/services/claude.ts` provides thin shims that forward to `agent.ts` for backward-compatible call sites.

---

## Authentication

mypa does **not** require a standalone Claude Code CLI installation. The `@anthropic-ai/claude-agent-sdk` carries its own bundled executable.

Credentials are resolved in priority order by `resolveAuthSource()` in `src/main/services/auth.ts`:

| Source | Condition | `AuthSource` value |
|---|---|---|
| Stored API key | `config.claude.apiKey` is non-empty | `'apikey'` |
| Env var | `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` in `process.env` | `'env'` |
| Claude login | `~/.claude/.credentials.json` exists | `'cli-login'` |
| None | None of the above | `'none'` |

**Important macOS caveat:** A Keychain-stored Claude Code login token is not readable by the file-based probe in step 3. `resolveAuthSource()` may return `{ ok: false, source: 'none' }` even when valid Keychain credentials exist. The onboarding wizard and Settings health panel treat this as a soft warning, not a hard error.

`buildAgentEnv()` (also in `auth.ts`) returns the `env` override to pass to `query()`:
- When an API key is configured: `{ ...process.env, ANTHROPIC_API_KEY: key }`.  
  The SDK `options.env` **replaces** the subprocess env entirely — `process.env` must be spread first to preserve `PATH`, `HOME`, etc.
- When no key is stored: `undefined` — the SDK inherits `process.env` unchanged, picking up ambient credentials.

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

- Calls the SDK `query()` with `tools: []` (no built-in tools) and `maxTurns: 1`.
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
| `detectClaudeBin()` | Removed — replaced by `resolveAuthSource()` in `auth.ts` |

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

**ASAR path fix — `pathToClaudeCodeExecutable` must be set explicitly.** The SDK's `sdk.mjs` lives inside `app.asar`; when it resolves the platform binary relative to its own `import.meta.url` it produces a path that includes `app.asar` — which is a file, not a directory — causing `spawn ENOTDIR` on every AI call. The fix is in `agent.ts`: `resolveClaudeExecutable()` computes the real, unpacked path via `app.getAppPath().replace('app.asar', 'app.asar.unpacked')`, then all three `query()` call sites pass `pathToClaudeCodeExecutable: resolveClaudeExecutable()`. This short-circuits the SDK's broken default without affecting dev mode (where `app.getAppPath()` points to the project root and the binary exists at the direct `node_modules` path).

## Changelog

- 2026-06-25 — **Fix one-shot digest "Reached maximum number of turns (3)" (`agent.ts`):** added `tools: []` to the `runAgentOnce` `query()` options so no built-in tools appear in the model's context. Previously the full Claude Code tool preset was available and the model would attempt tool calls that were denied one-by-one by `canUseTool`; each denial burned a turn and 3 stray attempts exhausted `maxTurns: 3` before any text was produced. With `tools: []` no tool calls can be attempted, `maxTurns` dropped back to `1`, and `canUseTool: deny` is retained as defense-in-depth. Affects all `runClaude`/`runAgent` callers (digests, classifications, inference).

- 2026-06-25 — **Ground plan-item chat in memory/graph context packet:** `handlePlanMessage` in `plan.ts` now assembles a `rawContext` string and passes it to `streamChat` (previously always `undefined`). The context contains the plan item's own title/detail/actions, followed by the full output of `assembleContextPacket('plan_chat', ['plan_item:<id>'])` + `renderPacketForPrompt` (relevant memories, focus graph node, related edges, recent signals, semantic matches). This matches the grounding that ambient intent chat (`handleIntentChat`) already received. Assembly is best-effort; errors fall back to ungrounded behavior. `'plan_chat'` added to the `TriggerKind` union.

- 2026-06-24 — **Fix `spawn ENOTDIR` in packaged app:** added `resolveClaudeExecutable()` helper in `agent.ts` that rewrites `app.getAppPath()` to the `app.asar.unpacked` path. All three `query()` call sites now pass `pathToClaudeCodeExecutable: resolveClaudeExecutable()`, preventing the SDK from resolving the binary to an `app.asar/…` path (a file, not a directory). See updated **Packaging** section above.

- 2026-06-22 — **Dual-source auth, CLI dependency removed:** new `src/main/services/auth.ts` with `buildAgentEnv()` (injects stored API key into `query()` options.env, spreading process.env to preserve PATH/HOME) and `resolveAuthSource()` (priority probe: stored key → env var → ~/.claude/.credentials.json → none). All three `query()` call sites in `agent.ts` now pass `env: buildAgentEnv()`. `detectClaudeBin()` and all CLI-detection helpers removed from `claude.ts`. `SetupHealth.claudeCli` replaced by `SetupHealth.auth: { ok, source: AuthSource }`. Onboarding Step 2 reworked from "install Claude Code CLI" to "Connect Claude" with inline API-key entry; no longer a hard block. Settings health row updated to show auth source instead of CLI presence.

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
