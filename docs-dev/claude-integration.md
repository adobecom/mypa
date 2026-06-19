# Claude Integration

All AI work in mypa goes through `src/main/services/claude.ts`, which spawns the `claude` CLI as a subprocess. There is no direct Anthropic API call — the CLI must be installed and authenticated separately.

---

## Binary discovery

`detectClaudeBin(): string | null` (exported from `claude.ts`) is the single resolver used by both the runtime spawn (`getClaude()`) and the setup/health IPC handlers. It never throws.

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

`getClaude()` calls `detectClaudeBin()` and throws the familiar `claude CLI not found — is Claude Code installed?` message if null. The resolved path is cached in `_claudeBin` **only on success**, so installing claude after launch is detected on the next spawn (no restart required).

`path-fix.ts` (`fixPath()`) also enumerates all nvm node-version bin dirs via `nvmBinDirs()` and adds `~/.claude/local`, `~/.npm-global/bin`, `~/.bun/bin`, and `~/.volta/bin` to `process.env.PATH`, so the `which claude` step usually succeeds even for installs whose PATH lines live in `.zshrc` (which the `-lc` login-shell probe deliberately skips for speed).

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
- prompt ≥ 12 000 chars → +1 tier
- prompt ≥ 40 000 chars → +2 tiers
- always clamped to `capable`

### `escalate(modelId)`

Returns the next-stronger model in the ladder, or `null` when already at `capable`. Used by `runClaude` and `streamChat` to retry failed/weak tasks with a stronger model.

---

## `runClaude` — one-shot completion

```ts
export async function runClaude(
  systemPrompt: string,
  userPrompt: string,
  source?: UsageSource,   // default 'other'
  timeoutMs?: number,     // default 120 000 ms
  expectJson?: boolean    // default false
): Promise<string>
```

- Concatenates system + user prompts into a single `-p` argument.
- Selects the initial model via `selectModel(source, fullPrompt.length)`.
- Flags: `--output-format json` (captures token usage in the JSON envelope).
- The CLI returns `{ result, usage, total_cost_usd, is_error }`. `result` is returned to the caller.
- After each attempt, `recordUsage(source, model, cliResult)` persists a row in `usage_events` (records the model that was actually used).
- Hard timeout: **120 seconds** (overridable via `timeoutMs`).
- **Automatic escalation:** if the call errors (`is_error`, non-zero exit, timeout, or a JSON-missing response when `expectJson=true`), the call is retried once at the next-stronger tier via `escalate()`. Gives up and rethrows at the top tier. Usage is recorded for each attempt.
- Pass `expectJson=true` for structured tasks that require a JSON response body — a plain-text response triggers escalation rather than silently resolving.

Used for: `generatePlanDraft` (`source='plan_draft'`, `expectJson=true`), `generateRoutineDigest` (`'routine_digest'`), `generateRoutineSetup` (`'routine_setup'`, `expectJson=true`), `inferIntent` / `inferRoutineIntents` in `inference.ts` (`'inference'`, `expectJson=true`), `runMemorySummarization` in `memories.ts` (`'memory'`, `expectJson=true`), `extractCheckInKnowledge` in `checkin.ts` (`'checkin_extract'`, `expectJson=true`).

---

## `streamChat` — streaming multi-turn chat

```ts
export async function streamChat(
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

The model is selected via `selectModel(source, approxLen)` where `approxLen` is the combined char count of the system prompt and all message contents. If the stream fails before any output reaches the client (`code !== 0 && !full`), it is retried once at the escalated tier. User-cancelled streams (`'Cancelled'` error) and idle-timed-out streams (`'Stream timed out'` error) are never retried.

The `source` param is threaded to `runClaudeStream`, which captures the `result` event from the CLI's NDJSON stream (the event carrying `usage` and `total_cost_usd`) and calls `recordUsage` on process exit.

When `enableMcp` is `true`, `streamChat` appends `MCP_CHAT_SYSTEM_ADDENDUM` to the system prompt and `runClaudeStream` calls `ensureServersConnected()` then `buildMcpInvocation()` to wire `--mcp-config` + `--allowedTools` into the CLI spawn.

**`MCP_CHAT_SYSTEM_ADDENDUM`** — tells the model it has read-only tools freely available, and governs the write-action protocol:
- Emitting an `<action>` block **does not execute anything** — it queues the write for the user's approval (Approve/Dismiss chip, or typing "go ahead"). The model must never claim the write happened; it should say "I've queued this for your approval".
- Valid `surface:verb` pairs: `github:comment`, `github:label`, `github:approve`, `jira:comment`, `slack:reply`, `slack:send`.
- `github:approve` maps to `create_pull_request_review` with `event: 'APPROVE'` — this flips a PR's formal review state, unlike `github:comment` which only posts an issue comment.
- The model receives rendered action-state in its history (`[proposed github:comment — status: pending, awaiting the user's Approve/Dismiss (NOT yet executed)]`) so it knows whether a prior proposal was approved, dismissed, or failed.

Internally calls `runClaudeStream`:
- Flags: `--output-format stream-json --verbose` plus optionally `--mcp-config <path> --allowedTools <csv>`.
- Parses `assistant` events from the NDJSON stream, extracting `content[].text` blocks.
- Calls `onChunk(text)` for each incremental chunk.
- Calls `onDone(fullText)` when the process exits cleanly.

### The `\x00SPLIT\x00` sentinel

The `claude` CLI occasionally emits multiple `assistant` events in a single response (e.g. a thinking block followed by a text block). When `parseStreamEvent` sees a new `assistant` event while `full` is already non-empty, it emits `'\x00SPLIT\x00'` to `onChunk` before the new block. The renderer uses this sentinel to visually separate multi-block responses.

### Context injection

Pass `rawContext` to inject the raw MCP output as context in the system prompt:

```
You are mypa, {persona}. Be concise and action-oriented.

Original data collected by this routine:
{rawContext}
```

### Stream IDs and cancellation

Every active stream is tracked in a `Map<streamId, { proc, killed }>`. Passing a `streamId` enables cancellation:

```ts
export function cancelStream(streamId: string): boolean
```

Sends `SIGTERM` to the subprocess and removes it from the active-streams map. Returns `true` if a stream was found and killed. The renderer calls `window.electron.routines.cancelStream(runId)` or `window.electron.plan.cancelStream(itemId)`.

---

## Generator helpers

### `generatePlanDraft(intent)`

Parses a free-text intent into a `PlanDraft`. Uses `runClaude` with a JSON-only system prompt. Includes the current time and hour so Claude can infer appropriate `timing` values.

Returns:
```ts
{ title, detail, timing: PlanItemTiming, actions: McpActionRef[], original_intent }
```

Falls back gracefully: if Claude's output doesn't contain a JSON object, throws. If fields are missing, defaults are applied (`timing → 'anytime'`, `actions → []`).

### `generateRoutineDigest(name, promptTemplate, rawOutput)`

Summarizes MCP tool outputs for a routine run. Uses `runClaude` with a 240 s timeout (larger than the default 120 s to handle big tool outputs).

Returns:
```ts
{ summary: string, body: string }
```

- `summary` — one-sentence headline (max ~120 chars), used as the OS notification body and run-row preview.
- `body` — full markdown digest that follows the routine's prompt instructions, including any requested grouping or sections.

The model is instructed to respond in the format:
```
SUMMARY: <one-sentence headline>

<full markdown body>
```

Parsing is line-delimited (no JSON), so rich grouped output is never discarded. If no `SUMMARY:` line is present, the first non-empty line is used as the headline.

**On failure:** logs the error with `console.error('[claude] routine digest failed:', err)` and returns `{ summary: 'Could not generate digest', body: 'The digest could not be generated. Reason: <message>. ...' }`. Never returns the silent `<name> completed` placeholder.

### `generateRoutineSetup(intent, servers)`

Converts a natural-language routine description + the live MCP tool catalog into a validated `RoutineSetupDraft`.

- Builds a `toolCatalog` string from connected `McpServerStatus[]` (only connected servers with ≥1 tool).
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

Users set their persona in the Settings panel.

## Owner identity clause

When the user has configured `AppConfig.owner` (name + per-surface handles), every system prompt also receives an owner-identity instruction via `buildOwnerClause()` (`config.ts`):

```
The person you assist is {name}. They appear across connected surfaces under these handles —
github: {handle}, slack: {handle}, …
When activity references any of those handles, that is {name} themselves — address them in the
second person ("you"), never in the third person or by their handle.
```

This clause is appended in: `generateRoutineDigest`, `streamChat`, `generatePlanDraft` (all in `claude.ts`), `inferIntent` (`inference.ts`), and `runMemorySummarization` (`memories.ts`). Returns `''` when owner is not configured, so prompts degrade gracefully.

### Standing directives clause (`buildDirectivesClause`)

When the user has hard memories (learned during check-ins with `enforcement = 'hard'`), every inference system prompt also receives a standing-directives block via `buildDirectivesClause()` (`config.ts`):

```
Standing rules you must always obey (set by the user in past check-ins):
  - <rule 1>
  - <rule 2>
If a candidate observation or proposed action would violate any of the above, do not surface it — return the "nothing actionable" response instead.
```

This clause is appended in `inferIntent` (`inference.ts`) **after** `buildOwnerClause()`, so it appears in the trusted system-prompt section — never inside the `<context>` data block (which the model is explicitly told to treat as data, not instructions). Re-read at every call (not cached), so newly-added hard rules take effect on the next inference cycle. Returns `''` when there are no hard memories.

## Usage recording

`src/main/services/usage.ts` provides the `recordUsage(source, model, cliResult)` function imported by `claude.ts`. It calls `dbInsertUsage()` and swallows all errors so telemetry never disrupts an AI call.

`UsageSource` labels: `'plan_draft'`, `'routine_digest'`, `'routine_setup'`, `'routine_chat'`, `'plan_chat'`, `'checkin_chat'`, `'checkin_extract'`, `'inference'`, `'memory'`, `'suggest'`, `'chat'`, `'other'`.

## Changelog

- 2026-06-18 — **Stream idle watchdog in `runClaudeStream`:** Added `STREAM_IDLE_TIMEOUT_MS = 120_000` constant and an idle timer inside `runClaudeStream`. The timer is armed immediately after spawn and resets on every `stdout` data event; if no output arrives for 120 s, the subprocess is killed with SIGTERM and the promise rejects with `'Stream timed out'`. A `settled` flag prevents the close handler from double-settling after the kill. Both the close and error handlers call `clearTimeout(idleTimer)`. The escalation loop in `streamChat` now treats `'Stream timed out'` as terminal (same as `'Cancelled'`) — no retry. Previously `runClaudeStream` was the only spawn path without a watchdog; this closes the gap that caused the "Chat about it" UI to hang forever when the agentic CLI subprocess wedged without producing output.

- 2026-06-19 — **Chat write-action correctness (four fixes):** (1) `MCP_CHAT_SYSTEM_ADDENDUM` rewritten to make the contract explicit — emitting an `<action>` block queues the write, never executes it; the model is told to say "queued for approval" and never imply the write happened. (2) Typed approval: `handleIntentChat` and `handlePlanMessage` detect a short affirmative/dismissal phrase ("go ahead", "approve", "yes", "no", "cancel", etc.) and, if a pending action exists in the thread, immediately call `approveChatAction`/`dismissChatAction` without streaming a model turn — the chip flips to `executed`/`dismissed` and a confirmation note is appended. (3) Action-state rendered into model history: action-only messages (empty content, action metadata) are replaced in the history fed to `streamChat` with a synthetic status line so the model knows whether a prior proposal is still pending, executed, or dismissed. (4) `github:approve` verb added — maps to `create_pull_request_review (event: APPROVE)` for formal PR approval; `buildToolArgs` github branch extended with a `pull_number` case.

- 2026-06-19 — **Plan-chat action parity:** `handlePlanMessage` now strips `<action>` blocks and surfaces Approve/Dismiss chips, matching intent chat. Shared helper `stageChatActionsFromSegment` extracted from the intent chat path. DB: `plan_item_threads` gains a `metadata TEXT` column (additive migration). New IPC channels `plan:approve-chat-action` / `plan:dismiss-chat-action`. Preload, `IpcApi.plan`, `PlanItemCard`, and `PlanItemDetail` all wired. `approvePlanAction` / `dismissPlanAction` in `ambient.ts` mirror the intent equivalents (no `action_log` FK since plan items are not intents).

- 2026-06-18 — **Live MCP in streaming chat (`enableMcp`):** `buildMcpInvocation()` helper extracted from `runClaudeWithMcp` — builds the `--mcp-config` temp file + `--allowedTools` list using `getKnownServerTools()` (survives dead in-process clients via `lastKnownTools` cache in `mcp.ts`). `runClaudeStream` and `streamChat` gain an optional `enableMcp?: boolean` param. When set: `runClaudeStream` calls `await ensureServersConnected()`, calls `buildMcpInvocation()`, appends the CLI flags, and `cleanup()`s the temp file on both close and error. `streamChat` appends `MCP_CHAT_SYSTEM_ADDENDUM` to the system prompt (read-only tool instructions + `<action>` block protocol for write proposals). All chat callers — `handleIntentChat`, `handleRunMessage`, `handlePlanMessage`, `handleCheckInMessage`, check-in briefing — pass `enableMcp: true`. `runClaudeWithMcp` now also uses `buildMcpInvocation()` internally (no behavior change, just deduplication).

- 2026-06-17 — **Automatic model selection + escalation:** replaced the single user-configured model with `model-router.ts`. `selectModel(source, promptChars)` picks a tier (fast/balanced/capable) from the task's `UsageSource` and bumps it up for large prompts (≥ 12 k chars → +1, ≥ 40 k → +2). `escalate(modelId)` returns the next-stronger tier and is called by `runClaude` and `streamChat` on failure — one retry per escalation step, stopping at `capable`. `runClaude` gains an `expectJson` parameter; `true` triggers escalation when the response lacks JSON structure. Removed the model dropdown from `Settings.tsx` and the "Choose a model" step 3 from `OnboardingWizard.tsx` (renumbered to 5 steps). `DEFAULT_CONFIG.claude` no longer seeds a model. Added `'suggest'` to `UsageSource` (was missing, causing a latent type error).

- 2026-06-16 — **Unified claude detection:** replaced the separate `execFileSync('/usr/bin/which', ['claude'])` calls in `setup:check-prerequisites` and `setup:get-health` with `detectClaudeBin()` (new export from `claude.ts`) so the wizard gate is identical to what the runtime uses. Broadened fallback candidate list to cover the official installer (`~/.claude/local/claude`), nvm node-version bin dirs (all versions, enumerated via `readdirSync`), `~/.npm-global/bin`, `~/.bun/bin`, and `~/.volta/bin`. `path-fix.ts` static dirs widened to match; `nvmBinDirs()` helper added there too. Failure is no longer cached — a null result leaves `_claudeBin` null so a post-launch install is picked up immediately.
- 2026-06-15 — **Digest format overhaul:** `RoutineDigest` changed from `{ summary, items, proposed_actions }` to `{ summary, body }`; `generateRoutineDigest` now uses a line-delimited `SUMMARY: <headline>\n\n<markdown body>` format instead of a JSON schema, with a 240 s timeout (up from 120 s); on parse, extracts the `SUMMARY:` line as the notification headline and everything below as the full markdown body; on hard failure, logs to console and returns an honest error message rather than the silent `<name> completed` placeholder. `runClaude` gains an optional `timeoutMs` param (default 120 s unchanged for all other callers).
- 2026-06-10 — **Standing directives clause:** added `buildDirectivesClause()` to `config.ts`; appended to the `inferIntent` system prompt alongside `buildOwnerClause()`; reads active hard memories via `dbGetActiveHardMemories()`. Hard memories are extracted from check-ins when the user states absolute rules; classification is done by the `checkin_extract` Claude call using a new `enforcement` field in the extraction JSON schema. Autonomous summarization (`memories.ts`) always defaults to `'soft'`. New `MemoryEnforcement` type in `src/shared/types.ts`.
- 2026-06-09 — added `claudeEnv()` helper in `claude.ts`; both `runClaude` and `runClaudeStream` now pass `env: claudeEnv()` to `spawn`, injecting `ANTHROPIC_API_KEY` when `AppConfig.claude.apiKey` is set; if unset the process inherits the parent env (CLI's own auth)
- 2026-06-07 — `runClaude` switched from `--output-format text` to `--output-format json`; added `source: UsageSource` param; both `runClaude` and `runClaudeStream` now call `recordUsage()` after each call; new `src/main/services/usage.ts` thin recorder
- 2026-06-07 — added owner-identity clause (`buildOwnerClause`) injected into all system prompts so the model addresses the owner as "you" when `AppConfig.owner` is configured
- 2026-06-07 — `generateRoutineDigest` hardened to never throw (strips markdown fences, wraps JSON.parse in try/catch, returns graceful default on any failure); `parseStreamEvent` in `runClaudeStream` hardened to only pass the `result` fallback when it is plain prose (not a JSON blob), preventing raw MCP tool output from appearing in chat
- 2026-06-06 — initial documentation
