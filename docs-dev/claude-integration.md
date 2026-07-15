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
| Claude login (file) | `~/.claude/.credentials.json` exists | `'cli-login'` |
| Claude login (Keychain, macOS only) | `security find-generic-password -s "Claude Code-credentials"` succeeds | `'cli-login'` |
| None | None of the above | `'none'` |

`claude login` on macOS stores its session in the Keychain rather than `~/.claude/.credentials.json`, so the file probe alone missed it — the Keychain probe (macOS only, via `execFileSync('security', ...)`) closes that gap. The Agent SDK subprocess runs as the same OS user, so it can read the same Keychain entry at call time, making this detection accurate rather than a soft-warning workaround. The probe runs with a 2s `timeout`: it's synchronous on the single-threaded main process, and if the Keychain item's ACL doesn't already authorize this process, macOS can show a native access-authorization dialog that `security` would otherwise block on indefinitely — the timeout makes an unresponded prompt fail closed (`ok: false`) instead of freezing the whole app.

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
| balanced | `claude-sonnet-5` |
| capable | `claude-opus-4-8` |

### `selectModel(source, promptChars)`

Maps each `UsageSource` label to a base tier, then bumps the tier up for large prompts:

| source | base tier |
|---|---|
| `inference`, `plan_draft` | fast |
| `routine_digest`, `routine_setup`, `routine_chat`, `plan_chat`, `checkin_chat`, `checkin_extract`, `memory`, `chat`, `review`, `other` | balanced |
| `suggest`, `authoring`, `routine_run` | capable |

`review` (ambient deep-enrichment, `inferDeepIntent`) was `capable` (Opus) until 2026-07-08; it accounted for ~97% of Opus spend since it runs unattended on the ambient heartbeat. Downgraded to `balanced` — see `budget.ts` and [ambient-intelligence.md](ambient-intelligence.md) for the accompanying throttle/budget-cap changes.

`runAgentOnce`'s `expectJson` path retries once at the *same* tier with a stricter "JSON only" instruction before throwing the error that feeds `escalate()` — most weak-JSON failures are a formatting slip, not a capability gap, so a same-tier retry is cheaper than climbing the ladder.

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

### `runRoutineAgent` — agentic scheduled routine run

```ts
export interface RoutineAgentResult {
  text: string
  rawOutput: string
  successCount: number
  failures: Array<{ server: string; tool: string; message: string }>
}

export async function runRoutineAgent(
  systemPrompt: string,
  userPrompt: string,
  timeoutMs?: number,     // default 300 000 ms
): Promise<RoutineAgentResult>
```

Used by `routines.ts` `executeRoutine` to drive a scheduled routine's data-gathering step. `source: 'routine_run'` → `capable` (Opus), `maxTurns: 15`, `canUseTool` allows only read-only tools (`isReadOnlyTool`, now exported for reuse — see `routines.ts` below) — an unattended run must never block on a write-tool approval prompt, so writes are denied outright rather than gated.

MCP servers are sourced from the warm connection pool exactly the way `streamAgentChat` does it — `await ensureServersConnected()` then `buildBridgedMcpServers()` — rather than cold-spawned from `AppConfig.mcp_servers` the way `runAgentWithMcp` does. A routine can fire many times a day, so cold-spawning a fresh stdio subprocess (and paying its handshake latency, and risking a redundant second connection to a server the pool already holds open) on every tick would be wasteful; the bridge also automatically excludes disabled servers, which a hand-rolled `AppConfig.mcp_servers` loop would not. `getServerStatus()` is also checked and any configured-but-disconnected server is called out by name in an `IMPORTANT:` prefix on the system prompt, mirroring `streamAgentChat`'s unavailability note (see below) — so the model reports an outage instead of confabulating results for a server it can't reach.

Unlike `runAgentWithMcp`, which discards everything but the final assistant text, `runRoutineAgent` reconstructs a per-tool-call record from the raw SDK message stream: each `assistant`-message `tool_use` block is indexed by its id → `{ server, tool }` (parsed from the `mcp__<server>__<tool>` name), and each subsequent `user`-message `tool_result` block is resolved back through that index and appended to either `toolOutputs` (success) or `failures` (`is_error`). `rawOutput` is `toolOutputs` joined as `"[server.tool]\n<content>"` blocks — the same shape `routines.ts` used to build directly from a static `callTool` loop — so the rest of the routine pipeline (digest generation, `extractCoveredEntities`, `inferRoutineIntents`) needed no changes downstream of Step 1. If the SDK's final result message is `is_error` (most commonly hitting `maxTurns: 15` mid-chain on a long list) but at least one tool call already succeeded or recorded a failure, that partial result is returned rather than discarded — a long "list N items, fetch each one's detail" routine that only gets partway through still produces a useful digest instead of an all-or-nothing error.

This exists because the old model — a fixed `actions: RoutineAction[]` list executed independently, one `callTool` per entry with no data-flow between them — could not express "list X, then for each result fetch its detail": the authoring LLM had to freeze detail-call params (e.g. a PR number) before any list call had actually run, so those params were placeholders that always failed against the real API. Routing the whole gather step through the agent loop lets the model call the list tool, read its own real output, and issue detail calls with real IDs.

### `streamAgentChat` — streaming multi-turn chat

```ts
export async function streamAgentChat(
  history: ChatMessage[],
  userMessage: string,
  onChunk: (chunk: string) => void,
  onDone:    (fullText: string) => void,
  rawContext?: string,
  streamId?:   string,
  source?:     UsageSource,          // default 'chat'
  enableMcp?:  boolean,              // default false
  onStatus?:   (status: string) => void,
): Promise<void>
```

- Drives a streaming async generator from the SDK.
- When `enableMcp` is `true`, MCP servers are sourced from the warm connection pool via `mcp-bridge.ts` (`buildBridgedMcpServers()`) rather than cold-spawned. The bridge wraps each connected server as an in-process `{ type: 'sdk', instance }` proxy — zero subprocess spawns, zero cold-boot latency. `ensureServersConnected()` is called first to best-effort reconnect any dead pool entries. Disconnected servers are absent from the chat turn (fast, honest). See [mcp-and-oauth.md](mcp-and-oauth.md#mcp-in-the-agent-sdk) for the bridge design.
- **Unavailability note:** after building the MCP server map, `getServerStatus()` is called to find any configured, enabled servers that are still disconnected (connection failed or timed out). If any are found, their names and last-known error reasons are appended to `systemPrompt` as an explicit `IMPORTANT:` clause telling the model not to use or claim to have used those servers. This prevents the model from confabulating tool results when a server silently fails to connect.
- Tool call gating is handled in-process via `canUseTool` (see below) rather than an allowlist flag.
- **Status heartbeat:** when `onStatus` is provided, a phase label is emitted immediately on startup (`'Connecting to tools…'` for MCP, `'Working…'` otherwise) and then re-emitted every 8 s so the renderer's 150 s safety backstop keeps resetting during long silent waits (MCP cold-boot, tool execution). The heartbeat is cleared as soon as the first text chunk arrives. The phase label advances to `'Working…'` on the first SDK message and `'Using {server}…'` when the model emits a tool call.
- **Timeout errors:** on idle-timeout the error now carries `noEscalate = true` and a human-readable message:
  - Pre-first-message: `'Timed out starting up tools. Check that your MCP servers are reachable, then try again.'`
  - Mid-stream: `'The assistant stopped mid-response. Please try again.'`
- Streams are never retried for user-cancelled (`'Cancelled'`) or timed-out responses (any error with `noEscalate = true`).
- **Human-wait latch:** a write-tool approval (`canUseTool`, below) or an `ask_user` question blocks on a human response, during which the SDK yields no messages — so nothing would otherwise call `resetIdle()`. `streamAgentChatOnce` tracks a `humanWaits` counter (`beginHumanWait`/`endHumanWait`) that both the `canUseTool` approval branch and `buildAskUserServer`'s answer wait increment/decrement around their `await`. While `humanWaits > 0`, the idle timer's fire handler (`onIdleFire`) re-arms itself instead of aborting — so a slow *human* reply is never mistaken for a stalled model/tool and doesn't trigger the "stopped mid-response" timeout. The explicit Stop button and stream-teardown paths still resolve pending approvals/questions immediately (via `pendingApprovalCancels`/`pendingQuestionCancels`), so a paused stream remains cancellable. This re-arming is bounded by `HUMAN_WAIT_HARD_CAP_MS` (30 min, tracked from `humanWaitStartedAt`) so a wait nobody ever resolves — a card dismissed without Stop, or two concurrent write-tool approvals colliding on the single-slot `pendingApprovalCancels`/`pendingQuestionCancels` registries (keyed by `streamId`, not per-request) — still eventually aborts instead of leaking the CLI subprocess for the app's lifetime. A `stopped` flag guards `resetIdle`/`onIdleFire` against re-arming a timer after the call has already exited (success or error), since a drained cancel-fn's `finally` can resolve as a later microtask.

### `cancelAgentChat` — interrupt an active stream

```ts
export function cancelAgentChat(streamId: string): boolean
```

Calls `Query.interrupt()` on the active stream and removes it from the in-memory map. Returns `true` if a stream was found and interrupted. The renderer calls `window.electron.routines.cancelStream(runId)` or `window.electron.plan.cancelStream(itemId)`.

### `runAuthoringAgent` — the one call site with real file/shell tools

```ts
export async function runAuthoringAgent(
  worktreePath: string,
  taskPrompt: string,
  onProgress?: (status: string) => void,
): Promise<{ text: string; ok: boolean; error?: string }>
```

Every other export in `agent.ts` deliberately passes `tools: []` (see Tool gating below) — this is the sole, intentional exception. It grants the built-in `Bash`, `Edit`, `Read`, `Write`, `Grep`, and `Glob` tools so Claude can actually author a code change, not just call MCP tools. Two layers keep this contained rather than an open sandbox escape:

1. **`cwd` is pinned to a disposable git worktree** created by `worktree.ts` — never the user's real checkout. The worktree is on its own branch (`mypa/<slug>`), created from the linked repo's default branch, and is pruned on discard.
2. **`canUseTool` confines the tools to that worktree**: `Edit`/`Write`/`Read` calls are denied if `file_path` resolves outside `worktreePath`; `Grep`/`Glob` are denied the same way when given an explicit out-of-worktree `path` (they default to `cwd`, i.e. the worktree, when `path` is omitted). `Bash` commands are checked against a denylist (`git push`/`fetch`/`pull`/`clone`/`remote`/`submodule`/`ls-remote`, `sudo`, `curl`, `wget`, `nc`, `ssh`, `scp`, `rsync`, `ftp`, `telnet`, `socat`, `dig`, `nslookup`, `getent hosts`, `/dev/tcp/`, `/dev/udp/`, `rm -rf /` or `~`).

**`Bash` is explicitly NOT path-confined**, unlike the other four tools — a command can read/write anywhere the OS user can, limited only by the denylist above matching the literal command string (a command that writes a script to a file and executes it, or otherwise obscures its target, is not caught). The code's own comments are explicit that this is a best-effort deterrent, not a sandbox, and that the real safety property this mode relies on is the disposable worktree plus the user-initiated approve-to-start flow — not that `Bash` itself is contained. A known, deliberately undocumented-as-solved residual risk: the agent's environment (via `buildAgentEnv()`) carries a live Anthropic API key or inherits an OAuth token when configured, since the SDK needs a credential to make its own API calls — that credential is visible to any `Bash` child process this same agent spawns, and a sufficiently malicious prompt-injected task could attempt to exfiltrate it via a technique the denylist doesn't cover (see the `BASH_DENY_RE` comment in `agent.ts` for the full reasoning).

A single wall-clock deadline (`AUTHORING_TIMEOUT_MS = 15 min`) bounds the whole run rather than the chat idle-timer pattern above, since an authoring run is unattended (no human watching for stalls) and may make many tool calls in a row. `maxTurns: 40`. Model tier is `'authoring'` → `capable` (Opus) unconditionally, since this is a user-initiated, approve-to-start action rather than something running unattended on a heartbeat. The agent does not commit or push — the caller (`authoring.ts`) does that only once the user reviews the diff and taps "Ship it". See [code-authoring.md](code-authoring.md) for the full flow.

---

## Tool gating — `canUseTool`

`canUseTool` is the SDK callback invoked before each tool call. It decides whether to auto-allow, auto-deny, or gate on user approval.

**Tool name format:** `mcp__<serverKey>__<toolName>`

Rules (applied in order):
1. Server key `mypa_builtin` — always allowed (covers the in-process `ask_user` tool).
2. Read-only prefix auto-allow: tool names starting with `get`, `list`, `search`, `read`, `fetch`, `find`, `describe`, `view`, `show`, `check`, `query`, `lookup` are allowed immediately — **unless** a subsequent name component is a write verb (`create`, `update`, `delete`, etc.), which would indicate a tool like `fetch_and_update`. That secondary check prevents prefix-spoofing by ambiguously named tools.
3. Non-MCP names (bare built-in tool names that do not carry the `mcp__server__tool` triple-part structure) — cleanly **denied**. Built-in tools should never appear here (both `streamAgentChatOnce` and `runAgentWithMcpOnce` now pass `tools: []`), but this guard prevents an indefinite approval-await hang if a built-in name somehow slips through.
4. All other (write) MCP tools — `canUseTool` broadcasts `chat:tool-approval-request` to the renderer with a `PendingToolApproval` object and then **awaits** resolution. The stream genuinely blocks until `resolveToolApproval()` is called. This await is wrapped in `beginHumanWait()`/`endHumanWait()` (see the human-wait latch above) so a slow approval doesn't get aborted by the idle timer, and the whole branch runs through a per-stream `runApprovalTurn` serial queue (`makeSerialQueue()`) so a second write-tool call doesn't broadcast its own card until this one has fully resolved — see "Serializing concurrent human-in-the-loop waits" below.

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

When the model needs a clarifying answer, it calls the in-process `ask_user` MCP tool (registered via `buildAskUserServer(streamId, hooks)`, where `hooks` is a required `{ begin, end, serialize, isStopped }` bundle from the caller).

**Tool input:** `{ prompt: string, options: string[], multiSelect?: boolean }`

**Flow:**
1. The whole handler runs through `hooks.serialize(...)` — a per-stream `runQuestionTurn` queue (see "Serializing concurrent human-in-the-loop waits" below) — and starts by checking `hooks.isStopped()`, returning an empty result without broadcasting if the stream was already cancelled while this question was queued behind an earlier one.
2. `ask_user` handler broadcasts `chat:ask-question` to the renderer with a `PendingQuestion` object.
3. The renderer shows clickable option chips.
4. The stream genuinely blocks until `resolveQuestion(questionId, answer)` is called — wrapped in `hooks.begin()`/`hooks.end()` so the idle timer re-arms instead of aborting while the user is deciding.
5. Calling `window.electron.chat.answerQuestion(questionId, answer)` from the renderer unblocks the stream.

This prevents the "No answer selected" bug — the turn truly blocks rather than continuing with a missing answer.

### `resolveQuestion(questionId, answer)`

```ts
export function resolveQuestion(questionId: string, answer: string): void
```

Unblocks a pending `ask_user` invocation with the user's chosen answer. Called by the `chat:answer-question` IPC handler.

---

## Serializing concurrent human-in-the-loop waits

The SDK can yield more than one `tool_use` block needing approval close together on the
same stream — most plausibly parallel tool calls in a single assistant turn, but also just
rapid same-tool retries after a failure. Both the renderer's `pendingToolApproval`/
`pendingQuestion` state (a single object, not a list, in every container that renders a
chat: `RoutineCard`, `PlanItemCard`, `PlanItemDetail`, `RunLogs`, `IntentCard`, `CheckInPage`)
and the backend's `pendingApprovalCancels`/`pendingQuestionCancels` maps (keyed by `streamId`,
one slot per stream) are single-slot. A second broadcast before the first is resolved
**silently overwrites and hides the first card** — it can never be clicked, its promise
never resolves, `endHumanWait()` never runs, and the stream hangs (no error, no visible card)
until `HUMAN_WAIT_HARD_CAP_MS`.

Rather than converting every one of those renderer components' state into a queue/array (a
much larger change), `streamAgentChatOnce` serializes the human-facing side instead:
`makeSerialQueue()` returns a `run(fn)` that chains calls onto a private promise tail, so a
second call queued behind a first doesn't start (and doesn't broadcast) until the first has
settled. Two per-call instances — `runApprovalTurn` and `runQuestionTurn` — wrap the
`canUseTool` write-tool branch and the `ask_user` handler respectively, so approvals and
questions each queue within their own category (they can still coexist, since they occupy
different renderer state/UI). This makes the existing single-slot registries correct again
by construction: they never hold two live entries for one stream at once.

A queued call checks `stopped || entry.interrupted` before doing anything — a card that was
waiting in the queue behind one just cancelled via Stop is discarded rather than flashing an
approval prompt to the user after they've already ended the conversation.

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

`UsageSource` labels: `'plan_draft'`, `'routine_digest'`, `'routine_setup'`, `'routine_chat'`, `'routine_run'`, `'plan_chat'`, `'checkin_chat'`, `'checkin_extract'`, `'inference'`, `'memory'`, `'suggest'`, `'review'`, `'authoring'`, `'chat'`, `'other'`.

## Packaging

`@anthropic-ai/claude-agent-sdk` platform binaries (e.g. `@anthropic-ai/claude-agent-sdk-darwin-arm64`) must be spawnable from a packaged app. The `package.json` build config includes `**/node_modules/@anthropic-ai/claude-agent-sdk-*/**` in `asarUnpack` so the native binary is extracted from the ASAR archive at install time.

**ASAR path fix — `pathToClaudeCodeExecutable` must be set explicitly.** The SDK's `sdk.mjs` lives inside `app.asar`; when it resolves the platform binary relative to its own `import.meta.url` it produces a path that includes `app.asar` — which is a file, not a directory — causing `spawn ENOTDIR` on every AI call. The fix is in `agent.ts`: `resolveClaudeExecutable()` computes the real, unpacked path via `app.getAppPath().replace('app.asar', 'app.asar.unpacked')`, then all four `query()` call sites (`runAgentOnce`, `streamAgentChatOnce`, `runAgentWithMcpOnce`, `runAuthoringAgent`) pass `pathToClaudeCodeExecutable: resolveClaudeExecutable()`. This short-circuits the SDK's broken default without affecting dev mode (where `app.getAppPath()` points to the project root and the binary exists at the direct `node_modules` path).

## Changelog

- 2026-07-15 — **Fix truncated write-tool approvals and the resulting stuck-forever hang (`agent.ts`, `ChatThread.tsx`).** Found while verifying the fix below: asking mypa to submit a GitHub PR review, the model called `create_pull_request_review` three times, each rejected with every parameter but `body` reported `undefined`, then the chat's thinking indicator hung indefinitely with no card and no error. Two distinct bugs. **Bug A:** `InlineToolApproval.handleApprove` (`ChatThread.tsx`) built the edited payload as `{ [approval.editableField]: draft }` — a full replacement, not a merge — and did so on *any* Approve click (not just an edited one) because `draft` is pre-seeded from `approval.editableValue`, so `draft.trim()` is truthy unedited. This dropped every parameter but the editable one; `canUseTool`'s `updatedInput: editedInput ?? inputRecord` fallback can't rescue it since `??` only falls back on `null`/`undefined`, not an incomplete object. Fixed to spread `approval.toolInput` first. The "asked 3 times" symptom was a consequence, not a separate bug: a failed `tool_result` never throws, so the model just retries within the same `maxTurns: 10` budget, each retry needing a fresh approval — fixing Bug A removes the repetition too. **Bug B**, the actual hang: confirmed as the "pre-existing" collision flagged in the entry below — a fallback tool call (the model's own retry-avoidance attempt) broadcast a second `chat:tool-approval-request` on the same stream while the first was still unresolved, silently clobbering the renderer's single-slot `pendingToolApproval` state and the single-slot `pendingApprovalCancels` map entry; the first approval's promise then never resolved, so `endHumanWait()` never ran and `humanWaits` stuck `> 0` until `HUMAN_WAIT_HARD_CAP_MS`. Fixed with a `makeSerialQueue()` helper and two per-call instances (`runApprovalTurn`, `runQuestionTurn`) wrapping the `canUseTool` write-branch and `buildAskUserServer` respectively, so a second human-facing wait on one stream is never broadcast until the first has fully resolved — see "Serializing concurrent human-in-the-loop waits" above for the full design. No renderer state/type changes were needed; serialization keeps the existing single-slot registries correct by construction.

- 2026-07-15 — **Fix "stopped mid-response" on write-tool approvals and `ask_user` questions (`agent.ts`).** Responding in a chat that follows a routine run (or any chat with MCP write tools enabled) could reliably time out ~140 s into waiting for a human to approve a write-tool call or answer an `ask_user` question, surfacing `'The assistant stopped mid-response. Please try again.'` and, in `~/.mypa/mypa.log`, `Tool permission request failed: Error: Tool permission stream closed before response received`. Root cause: `canUseTool`'s write-tool approval await (`agent.ts`) and `buildAskUserServer`'s answer await both block on a human response, during which the SDK yields no messages — so nothing called `resetIdle()`, and the idle timer (armed to `STREAM_STARTUP_TIMEOUT_MS` by the preceding `mcp_tool_use` message) fired and called `ac.abort()`, which closes the SDK subprocess's stdin and causes the CLI to reject the still-pending permission request with that exact message. Fixed by adding a `humanWaits` counter (`beginHumanWait`/`endHumanWait`) in `streamAgentChatOnce`: the idle timer's fire handler (`onIdleFire`) now re-arms itself instead of aborting while `humanWaits > 0`. Both the `canUseTool` write-approval branch and `buildAskUserServer` (now takes an optional `hooks: { begin, end }` param, threaded from the call site) wrap their blocking awaits in `beginHumanWait()`/`endHumanWait()`. Cancellation is unaffected — the Stop button and stream-teardown paths still resolve pending approvals/questions immediately via `pendingApprovalCancels`/`pendingQuestionCancels`. Ruled out during investigation: the "supersede stale runs" feature (never touches active streams) and the "LLM CTA labels" feature (confined to the ambient IntentCard path, doesn't touch `agent.ts`); `buildPendingToolApproval` remains synchronous and correctly unawaited.

  **Hardening pass (same commit), from review:** removing the unconditional abort also removed the only safety net for a human-in-the-loop wait that's abandoned rather than resolved — e.g. a card dismissed without hitting Stop, or two concurrent write-tool approvals colliding on the single-slot `pendingApprovalCancels`/`pendingQuestionCancels` registries (keyed by `streamId`, not per-request — pre-existing, but this change is the first place its consequence becomes load-bearing). Added `HUMAN_WAIT_HARD_CAP_MS = 30 * 60_000`: `onIdleFire` now only re-arms while `humanWaits > 0` **and** `Date.now() - humanWaitStartedAt` is under the cap, so an abandoned wait still eventually aborts instead of leaking the CLI subprocess for the app's lifetime. Also added a `stopped` flag, set once the call's loop has exited (success or error): `resetIdle`/`onIdleFire` no-op after `stopped`, closing a smaller leak where a cancel-fn's `finally` resolving as a later microtask (after `catch`'s `clearTimeout`) could schedule a new, never-cleared timer.

- 2026-07-14 — **Upgraded `balanced` tier to `claude-sonnet-5`; removed dead `ClaudeConfig.model` field (`model-router.ts`, `types.ts`).** `TIERS`/`TIER_MODEL` now map `balanced` → `claude-sonnet-5` (was `claude-sonnet-4-6`); `fast` (`claude-haiku-4-5-20251001`) and `capable` (`claude-opus-4-8`) were already current, so no change there. Also dropped the unused `model?: string` field from `ClaudeConfig` — it was never read for selection (model choice is entirely driven by `model-router.ts`), only `apiKey` remains.

- 2026-07-14 — **New `runRoutineAgent` — agentic scheduled routine runs (`agent.ts`, `routines.ts`, `claude.ts`, `model-router.ts`, `types.ts`, `UsageDashboard.tsx`, `RoutineForm.tsx`).** Scheduled routines previously executed a fixed `actions: RoutineAction[]` list, one independent `callTool` per entry with no data-flow between steps — an authoring LLM (`generateRoutineSetup`) had no way to feed a "list" call's real output into a later "per-item detail" call's params, so those params were frozen placeholders (e.g. `pull_number: 0`) that always 404'd against the real API, surfacing as an opaque `MCP error -32603: Not Found` "blocker" even when the MCP connection/token were completely healthy. `runRoutineAgent(systemPrompt, userPrompt, timeoutMs?)` fixes this by running the gather step agentically: read-only-gated MCP tools (`isReadOnlyTool`, now exported), `maxTurns: 15`, new `'routine_run'` `UsageSource` → `capable` (Opus), MCP servers sourced from the warm bridge pool (`ensureServersConnected` + `buildBridgedMcpServers`, same as `streamAgentChat`) rather than cold-spawned, and a message-stream walk that reconstructs `{ text, rawOutput, successCount, failures }` by indexing `tool_use` blocks by id and resolving each subsequent `tool_result` back to `{ server, tool }` — see the `runRoutineAgent` section above. A run that ends `is_error` after collecting at least one tool result (typically `maxTurns` exhaustion mid-chain on a long list) returns that partial result instead of discarding it. `routines.ts` `executeRoutine` now calls this whenever `routine.prompt` is non-empty; any *non*-read-only entry in `routine.actions` is still executed directly via `callTool` first (exactly as the old static loop did — the agentic step is deliberately read-only, so a routine explicitly configured to perform a write would otherwise have it silently denied), and only read-style actions are passed to the agent as a non-authoritative hint. The agent's `failures` are folded back into `rawOutput` (matching the old loop's inline `"[server.tool] ERROR: message"` format) so `generateRoutineDigest` doesn't lose visibility into partial failures. Empty-prompt legacy routines still use the old static loop. `claude.ts`'s `generateRoutineSetup` prompt now explicitly forbids the authoring LLM from inventing placeholder IDs and tells it to push all per-item logic into `prompt` instead of `actions`. `UsageDashboard.tsx` and `RoutineForm.tsx` copy updated to match.

- 2026-07-13 — **`resolveAuthSource()` now probes the macOS Keychain (`auth.ts`).** Onboarding's "Connect Claude" step was reporting no credentials for users logged in via `claude login` on macOS, because that flow stores its session in the Keychain, not `~/.claude/.credentials.json`. Added a `security find-generic-password -s "Claude Code-credentials"` check (guarded by `process.platform === 'darwin'`) as a fourth detection step, so Keychain-only logins now resolve to `{ ok: true, source: 'cli-login' }` instead of falling through to `'none'` and prompting for an API key that wasn't actually needed.

- 2026-07-09 — **Security review follow-up on `runAuthoringAgent` (`agent.ts`).** `canUseTool` now also confines `Grep`/`Glob` to the worktree by path (previously unconditionally allowed — a de facto arbitrary-file-read across the whole filesystem, since neither tool's `path` argument was checked). `BASH_DENY_RE` expanded to cover `git ls-remote` and common network/DNS tools (`ftp`, `telnet`, `socat`, `dig`, `nslookup`, `getent hosts`, `/dev/tcp/`, `/dev/udp/`) with no legitimate use in a build/lint/test workflow — deliberately does not block bare interpreter invocation (`python`/`node`/`perl`/`ruby`) since the system prompt legitimately allows running local test suites through them. The file-level and inline comments were also corrected to stop overclaiming full containment for `Bash` and to honestly document the residual live-credential-in-environment risk (see the paragraph above).

- 2026-07-09 — **New `runAuthoringAgent` — the one call site with real file/shell tools (`agent.ts`).** Added to support code-authoring (see [code-authoring.md](code-authoring.md)). Every other export in this file passes `tools: []`; `runAuthoringAgent` is the sole, deliberate exception, granting `Bash`/`Edit`/`Read`/`Write`/`Grep`/`Glob`. Contained by (1) `cwd` pinned to a disposable git worktree (`worktree.ts`), never the user's real checkout, and (2) a `canUseTool` gate that denies `Edit`/`Write`/`Read` calls whose `file_path` resolves outside the worktree and denies `Bash` commands matching a network/git-push/clone/remote/submodule/destructive denylist. New `'authoring'` `UsageSource` → `capable` (Opus) unconditionally in `model-router.ts` (unlike `'review'`, this is user-initiated and runs at most once per approved intent, not on an unattended heartbeat). `resolveClaudeExecutable()`/`pathToClaudeCodeExecutable` now has four call sites, not three.

- 2026-07-08 — **Cut Opus spend: downgrade `'review'` to Sonnet + same-tier JSON retry (`model-router.ts`, `agent.ts`).** `usage_events` analysis showed the `'review'` source (`inferDeepIntent`, ambient deep-enrichment) was ~97% of all Opus requests over 7 days because it ran unattended on the ambient heartbeat at base-tier `capable`. `SOURCE_TIER['review']` changed to `'balanced'` (Sonnet); still bumps to `capable` for genuinely large (>40k char) context packets via the existing size threshold. Separately, `runAgentOnce` now retries once at the same model tier — with `\n\nReturn ONLY raw JSON — no prose, no markdown code fences, no explanation.` appended to the prompt — before throwing the non-JSON error that `runAgent`'s loop catches and escalates on. This targets the ~317/7d `inference` calls that were climbing Haiku→Sonnet purely on malformed (not under-capable) output. Companion throttle/budget-cap changes (`MAX_DEEP_PER_CYCLE`, `synthesisIntervalMs`, new `budget.ts`) are in `ambient-intelligence.md` and `services.md`.

- 2026-07-01 — **Tool-result error logging in both MCP-enabled agent paths (`agent.ts`).** Both `streamAgentChatOnce` (streaming chat) and `runAgentWithMcpOnce` (one-shot with MCP) now inspect `user`-type SDK messages for `tool_result` blocks with `is_error: true` and call `logError('agent', …)` via the new `logger.ts`. Previously the only record of a failing tool call was the model's narrative — which is documented (agent.ts:376-405) to confabulate ZodError/schema/session diagnoses when tools are unavailable. Real errors now appear in `~/.mypa/mypa.log`. See also the `mcp-bridge.ts` hardening in `services.md`.

- 2026-06-30 — **`ROUTINE_SYSTEM_PROMPT` guardrails against error-only runs and self-targeted sends (`inference.ts`).** Added two rules to the `Rules:` block: (1) if the routine output contains only errors/failed tool calls, return a single `type:"flag"` describing the failure — do not propose any action; (2) never propose sending a message/comment to the owner (the user you assist) themselves — return `type:"flag"` if the only plausible recipient is the owner. These complement the code-level fix in `routines.ts` (which skips inference on all-failed runs) and the `guardSelfTarget` routing guard in `ambient.ts`, providing prompt-level guidance for the partial-failure path.

- 2026-06-30 — **Fix Slack read tools misclassified as writes (`agent.ts`):** `isReadOnlyTool` uses a prefix-component heuristic to classify MCP tool names. Slack's primary read tools — `conversations_history`, `conversations_replies`, `conversations_unreads` — contain no read-verb component (`get`/`list`/`search`/etc.) and fell through to "write." Consequence: in the one-shot MCP path (`runAgentWithMcpOnce`, used by ambient/Suggest) these were denied outright; in interactive chat they triggered a user approval prompt for a pure read operation. Added `READ_ONLY_TOOL_NAMES: Set<string>` (checked before the prefix heuristic) with these three entries as explicit overrides.

- 2026-06-29 — **Fix contextGuidance banning all tools when rawContext is present (`agent.ts`):** The `contextGuidance` note (added 2026-06-25 to prevent redundant fetches) instructed the model to "not call any tools" whenever the requested URLs/IDs/titles were already in `rawContext`. For GitHub PR observation items this always fired — the PR URL is always in rawContext — silently preventing the model from calling any GitHub tools. Without tools, the model fabricated a reason it couldn't act (ZodError, permission gate), because it had no honest explanation. Fixed to: "Basic metadata is already below — read it from there. Use tools to retrieve additional details not already present (PR diff, file contents, comments)." All MCPs were green throughout; the bug was in the instruction, not the connection.

- 2026-06-29 — **Harden unavailability note: prepend + override-history clause (`agent.ts`):** Two improvements to the unavailability note. (1) Changed from append to prepend — the note now sits at the top of `effectiveSystemPrompt` so it occupies the highest-priority region and is less likely to be discounted against the model's recent conversation context. (2) Added an explicit "overrides any prior claims in this conversation" clause, listing the specific hallucination types to discard (permission errors, schema validation errors, ZodErrors, session bugs). Without this, when the chat thread already contains a prior hallucinated diagnosis (e.g. a ZodError narrative from a previous turn), the model echoes it as "confirmed" even after the unavailability note is injected — because it sees its own prior assertion in context and trusts it over an appended system note.

- 2026-06-27 — **Surface unavailable MCP servers to model to prevent confabulation (`agent.ts`, `mcp.ts`):** `streamAgentChat` now calls `getServerStatus()` after `buildBridgedMcpServers()` and builds `effectiveSystemPrompt` — a copy of `systemPrompt` extended with an `IMPORTANT:` clause listing any configured, enabled servers that are still disconnected (with their last error reason from the new `mcp.ts` `serverErrors` Map). The clause instructs the model not to claim to have used those servers and to report the outage instead. Without this, silent server omission causes the model to fabricate detailed false root causes when tools are simply unavailable.

- 2026-06-27 — **Strip built-in tools from streaming/MCP paths; harden `canUseTool`; EPIPE guard (`agent.ts`, `index.ts`):** (1) `streamAgentChatOnce` and `runAgentWithMcpOnce` now both pass `tools: []` to `query()`, removing Bash/Edit/Write and all other built-in tools from the model's context. Chat sessions use MCP tools + the in-process `ask_user` tool only — matching `runAgentOnce`'s behavior. Previously, the model could reach for Bash during PR-review chat; `canUseTool` would shunt it into the write-approval await path, which the renderer cannot surface for non-MCP tools, causing an indefinite hang and eventual "The assistant stopped mid-response." timeout. (2) `canUseTool` now cleanly denies any non-MCP tool name (one that lacks the `mcp__server__tool` triple-part structure) before reaching the user-approval branch, as defense-in-depth. (3) `src/main/index.ts` registers `process.on('uncaughtException')` and `process.on('unhandledRejection')` before `main()` runs. The exception handler silently drops `EPIPE` errors (benign async write-to-closed-stdin from the SDK subprocess), while routing all other errors to `console.error` and, in packaged builds, `dialog.showErrorBox`.

- 2026-06-26 — **New `'review'` usage source (Opus) + generalized `isReadOnlyTool` (`model-router.ts`, `agent.ts`).** Added `'review'` to `UsageSource` and `SOURCE_TIER`, mapped to `'capable'` (Opus). Used by `inferDeepIntent` for agentic deep-enrichment of directed-at-me items. `isReadOnlyTool` now checks *any* underscore-component for a read-only prefix (not just the first), so vendor-prefixed reads like `jira_get_issue` and `workday_search_tasks` are correctly allowed in the read-only agentic loop. The secondary `WRITE_WORDS` guard prevents hybrid tool names (e.g. `get_or_create`) from being misclassified as read-only.

- 2026-06-26 — **Eliminate MCP cold-boot in chat via in-process bridge (`agent.ts`, `mcp.ts`, `mcp-bridge.ts`):** `streamAgentChat` no longer builds stdio/http/sse configs that the SDK cold-spawns. Instead it calls `await ensureServersConnected()` then `buildBridgedMcpServers()` (new `mcp-bridge.ts`), which produces `{ type: 'sdk', instance }` in-process proxy servers backed by the warm `mcp.ts` pool. The SDK calls `instance.connect(transport)` on these — no subprocess is ever spawned for chat turns. Cold-boot latency (previously up to 140 s per chat turn for N stdio MCP servers) drops to zero. Disconnected servers are simply absent from the map rather than hanging the stream. The `canUseTool` write-gate, `ask_user` server, and status heartbeat are unaffected.

- 2026-06-26 — **Chat status heartbeat + specific timeout errors (`agent.ts`, `claude.ts`, `ambient.ts`, `plan.ts`, renderer):** `streamAgentChat`/`streamAgentChatOnce` accept an optional `onStatus` callback. When provided, a phase label is emitted immediately and every 8 s via `setInterval` so the renderer's 150 s safety backstop resets during long MCP cold-boot/tool-wait silences — making the backstop a true "main process died" guard rather than a race against the server watchdog. Phase transitions: `'Connecting to tools…'` on startup, `'Working…'` on first SDK message, `'Using {server}…'` on each tool call. The heartbeat clears on the first real text chunk. Timeout errors now carry `noEscalate = true` and specific text depending on whether the first SDK message had arrived. `ambient.ts` and `plan.ts` pass `onStatus` callbacks that broadcast status frames (`{ done: false, status }`) on their respective push channels. The renderer components (`IntentCard`, `PlanItemCard`, `PlanItemDetail`) handle status frames — resetting the backstop and updating the phase label — and also reset the backstop when `chat:tool-approval-request` and `chat:ask-question` events arrive. `ChatThread` renders `statusLabel ?? 'Thinking…'` in the thinking bubble.

- 2026-06-25 — **Fix "Stream timed out" on observation chat — tool-call idle (`agent.ts`):** `resetIdle()` now accepts an optional `ms` parameter. When the SDK yields an assistant message containing `tool_use` blocks, `resetIdle` is called a second time with `STREAM_STARTUP_TIMEOUT_MS` (140 s), giving the MCP server network round-trip the same generous budget as the initial cold-spawn. Without this the 120 s inter-chunk timer fired during tool execution before the result arrived.

- 2026-06-25 — **Fix "Stream timed out" on observation chat — startup budget (`agent.ts`):** `streamAgentChatOnce` now uses two timeout constants instead of one. `STREAM_STARTUP_TIMEOUT_MS = 140_000` covers the first-message budget (needed because the Agent SDK cold-spawns all configured stdio MCP subprocesses before the first message arrives); `STREAM_IDLE_TIMEOUT_MS = 120_000` remains as the inter-chunk idle timeout once the stream is active. The `allMcpServers`/`hasMcp` computation was moved above the AbortController setup so `hasMcp` is available when selecting the first-message budget. Additionally, when `rawContext` is present, the system prompt now includes a context-guidance sentence telling the model to answer links/IDs directly from the injected data instead of calling tools — eliminates unnecessary MCP round-trips for read-only queries.

- 2026-06-25 — **Harden SDK harness: timeout race, null-result logging, write-word guard (`agent.ts`):** (1) Removed `if (timedOut)` checks from the *success* paths of `runAgentOnce`, `runAgentWithMcpOnce`, and `streamAgentChatOnce`. If the `for await` loop exits cleanly, the response is valid even if the timer fired in the final moments — throwing a false "timed out" there was incorrect. The `timedOut` flag is still checked in the `catch` path, which is the correct place. (2) Added `console.warn` when the SDK completes without emitting a `result` message (null-resultMsg case), making that rare path observable before the throw. (3) Added a `WRITE_WORDS` blocklist to `isReadOnlyTool`: if any word after the first in a tool name (split on `_`) is a write verb (`create`, `update`, `delete`, etc.), the tool is denied even when the name starts with a read prefix — prevents tools like `fetch_and_update` from being auto-allowed.

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
