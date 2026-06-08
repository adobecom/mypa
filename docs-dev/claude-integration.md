# Claude Integration

All AI work in mypa goes through `src/main/services/claude.ts`, which spawns the `claude` CLI as a subprocess. There is no direct Anthropic API call — the CLI must be installed and authenticated separately.

---

## Binary discovery

```ts
// Priority order:
1. which claude         (shell PATH)
2. /usr/local/bin/claude
3. $HOME/.local/bin/claude
```

The resolved path is cached in `_claudeBin` for the lifetime of the process. If none of the above are found, the function throws:

```
claude CLI not found — is Claude Code installed?
```

---

## Model selection

The model is read at every call from `readConfig().claude.model` (live — changes in Settings take effect immediately without restarting).

Default: `claude-opus-4-8` (set in `DEFAULT_CONFIG`).

Model args: `['--model', model]` — omitted if the config value is empty/unset (CLI uses its own default).

---

## `runClaude` — one-shot completion

```ts
export async function runClaude(
  systemPrompt: string,
  userPrompt: string,
  source?: UsageSource   // default 'other'
): Promise<string>
```

- Concatenates system + user prompts into a single `-p` argument.
- Flags: `--output-format json` (switched from `text` to capture token usage).
- The CLI returns a single JSON object `{ result, usage, total_cost_usd, is_error }`. `result` is returned to the caller (existing callers regex-extract JSON from it unchanged).
- After a successful call, `recordUsage(source, model, cliResult)` is called to persist a row in `usage_events`.
- Hard timeout: **120 seconds** — kills the process and rejects if exceeded.
- On JSON parse failure (unexpected CLI output format), falls back to returning raw `stdout.trim()`.

Used for: `generatePlanDraft` (`source='plan_draft'`), `generateRoutineDigest` (`'routine_digest'`), `generateRoutineSetup` (`'routine_setup'`), `inferIntent` in `inference.ts` (`'inference'`), `runMemorySummarization` in `memories.ts` (`'memory'`).

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
  source?:     UsageSource   // default 'chat'
): Promise<void>
```

The `source` param is threaded to `runClaudeStream`, which captures the `result` event from the CLI's NDJSON stream (the event carrying `usage` and `total_cost_usd`) and calls `recordUsage` on process exit.

Internally calls `runClaudeStream`:
- Flags: `--output-format stream-json --verbose`.
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

Summarizes MCP tool outputs for a routine run. Uses `runClaude` with a JSON-only prompt.

Returns:
```ts
{ summary: string, items: string[], proposed_actions: string[] }
```

**Never throws.** Returns the graceful default `{ summary: '<name> completed', items: [], proposed_actions: [] }` on any failure — including `runClaude` errors, markdown-fenced responses, and JSON parse failures. Strips ` ```json ` fences before parsing so Claude's habit of wrapping JSON in code blocks doesn't cause errors.

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

## Usage recording

`src/main/services/usage.ts` provides the `recordUsage(source, model, cliResult)` function imported by `claude.ts`. It calls `dbInsertUsage()` and swallows all errors so telemetry never disrupts an AI call.

`UsageSource` labels: `'plan_draft'`, `'routine_digest'`, `'routine_setup'`, `'routine_chat'`, `'plan_chat'`, `'inference'`, `'memory'`, `'chat'`, `'other'`.

## Changelog

- 2026-06-07 — `runClaude` switched from `--output-format text` to `--output-format json`; added `source: UsageSource` param; both `runClaude` and `runClaudeStream` now call `recordUsage()` after each call; new `src/main/services/usage.ts` thin recorder
- 2026-06-07 — added owner-identity clause (`buildOwnerClause`) injected into all system prompts so the model addresses the owner as "you" when `AppConfig.owner` is configured
- 2026-06-07 — `generateRoutineDigest` hardened to never throw (strips markdown fences, wraps JSON.parse in try/catch, returns graceful default on any failure); `parseStreamEvent` in `runClaudeStream` hardened to only pass the `result` fallback when it is plain prose (not a JSON blob), preventing raw MCP tool output from appearing in chat
- 2026-06-06 — initial documentation
