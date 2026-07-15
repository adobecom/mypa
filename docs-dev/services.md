# Main Process Services

All services live in `src/main/services/`. They run in the Node.js main process and are called from `src/main/ipc-handlers.ts` or from each other.

---

## `auth.ts` — Claude authentication resolver

Determines and injects Claude credentials for every SDK call.

**Key exports:**

| Export | Description |
|---|---|
| `resolveAuthSource()` | Returns `{ ok: boolean; source: AuthSource }` — probes in order: stored config API key → `ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN` env var → `~/.claude/.credentials.json` → (macOS only) `security find-generic-password -s "Claude Code-credentials"` Keychain check → `'none'`. Used by `setup:check-prerequisites` / `setup:get-health`. |
| `buildAgentEnv()` | Returns `{ ...process.env, ANTHROPIC_API_KEY: key }` when a key is stored, or `undefined` otherwise. Passed as `options.env` to all `query()` calls in `agent.ts`. |

`AuthSource` type: `'apikey' | 'env' | 'cli-login' | 'none'` (exported from `@shared/types`).

---

## `agent.ts` — Claude Agent SDK integration

Implements all AI calls using `@anthropic-ai/claude-agent-sdk` directly (no subprocess spawn). See [claude-integration.md](claude-integration.md) for the detailed write-up.

`resolveClaudeExecutable()` (module-private, memoized) computes the real path to the SDK's bundled native binary. In a packaged app it rewrites `app.getAppPath()` from `app.asar` to `app.asar.unpacked`; in dev it returns the `node_modules` path unchanged. All three `query()` call sites pass this via `pathToClaudeCodeExecutable` to prevent `spawn ENOTDIR` in packaged builds (see [claude-integration.md — Packaging](claude-integration.md#packaging)).

**Key exports:**

| Export | Description |
|---|---|
| `runAgent(systemPrompt, userPrompt, source?, timeoutMs?, expectJson?)` | One-shot completion via SDK `query()` with `tools: []` (no built-in tools) and `maxTurns: 1`; model auto-selected via `model-router.ts`; escalates to next tier on failure; records usage per attempt |
| `runAgentWithMcp(systemPrompt, userPrompt, source?)` | One-shot with live MCP servers passed via `options.mcpServers`; uses `tools: []` (built-ins disabled); falls back to `runAgent` if no servers are connected |
| `runRoutineAgent(systemPrompt, userPrompt, timeoutMs?)` | Agentic MCP run for a **scheduled routine** (`source: 'routine_run'`, `maxTurns: 15`, read-only tools only via `canUseTool`/`isReadOnlyTool`, both exported for reuse). MCP servers are sourced from the warm bridge pool (`ensureServersConnected()` + `buildBridgedMcpServers()`, same as `streamAgentChat`) rather than cold-spawned — a routine can fire many times a day, so cold-spawning per run would be wasteful and would ignore each server's enabled/disabled flag. Unlike `runAgentWithMcp`, it also walks the SDK message stream to reconstruct per-tool-call results: every `tool_use` block is indexed by id, and the matching `tool_result` (success or `is_error`) is resolved back to `{ server, tool }` from that index. Returns `{ text, rawOutput, successCount, failures }` — `rawOutput` is the `"[server.tool]\n<content>"`-joined successful results (mirrors the old static `callTool` loop's format), `failures` is `{ server, tool, message }[]`. A final `is_error` result with at least one already-gathered tool result returns that partial data instead of discarding it (covers hitting `maxTurns` mid-chain on a long list). Used by `routines.ts` `executeRoutine` in place of a fixed action list so a routine can chain a list-style call's real results into later per-item detail calls. |
| `streamAgentChat(history, userMessage, onChunk, onDone, rawContext?, streamId?, source?, enableMcp?, onStatus?)` | Streaming multi-turn chat via async generator; uses `tools: []` (built-ins disabled — MCP + ask_user only); when `enableMcp` is true, MCP servers are wired in via `options.mcpServers` and `canUseTool` gates write tools on user approval; `onStatus` receives phase-label updates and a periodic heartbeat so callers can keep the renderer safety backstop alive during silent MCP waits. The idle timer that would otherwise abort a stalled stream re-arms itself instead while a write-tool approval or `ask_user` question is awaiting a human response (see the human-wait latch note in [claude-integration.md](claude-integration.md)). |
| `cancelAgentChat(streamId)` | Interrupt an active stream via `Query.interrupt()`; returns `true` if found |
| `resolveToolApproval(approvalId, allow, editedInput?)` | Unblock a pending `canUseTool` write-gate; called by the `chat:resolve-tool-approval` IPC handler |
| `resolveQuestion(questionId, answer)` | Unblock a pending `ask_user` tool invocation; called by the `chat:answer-question` IPC handler |
| `buildAskUserServer(streamId, hooks?)` | Internal: creates the in-process MCP server exposing the `ask_user` tool. `hooks: { begin, end }`, when passed, bracket the wait for the user's answer so the caller's idle timer treats it as a human-in-the-loop wait (see the human-wait latch note under `streamAgentChat` in [claude-integration.md](claude-integration.md)) instead of a stalled model/tool. |
| `runAuthoringAgent(worktreePath, taskPrompt, onProgress?)` | **The only call site in this file that grants built-in file/shell tools** (`Bash`, `Edit`, `Read`, `Write`, `Grep`, `Glob`) — every other export above deliberately runs with `tools: []`. `cwd` is pinned to an isolated git worktree (see `worktree.ts`); `canUseTool` confines file writes to that worktree and blocks network access and `git push`/`clone`/`remote`/`submodule`. Used by `authoring.ts`; does not commit or push — the caller does that once the user approves the diff. |

---

## `claude.ts` — thin shim layer

Forwards calls to `agent.ts`. The subprocess-spawn code has been removed. See [claude-integration.md](claude-integration.md) for details.

**Key exports:**

| Export | Description |
|---|---|
| `runClaude(systemPrompt, userPrompt, source?, timeoutMs?, expectJson?)` | Shim → `runAgent(...)` |
| `runClaudeWithMcp(systemPrompt, userPrompt, source?)` | Shim → `runAgentWithMcp(...)` |
| `streamChat(history, userMessage, onChunk, onDone, rawContext?, streamId?, source?, enableMcp?, onStatus?)` | Shim → `streamAgentChat(...)` |
| `cancelStream(streamId)` | Shim → `cancelAgentChat(streamId)` |
| `generatePlanDraft(intent)` | Parse free-text intent → `PlanDraft` |
| `generateRoutineDigest(name, promptTemplate, rawOutput)` | Summarize MCP output → `RoutineDigest` (`{ summary, body }`) |
| `generateRoutineSetup(intent, servers)` | Natural-language intent → validated `RoutineSetupDraft` |

---

## `model-router.ts` — Automatic model selection

Stateless, pure module. No I/O; no config reads. The single source of truth for which Claude model to use.

**Key exports:**

| Export | Description |
|---|---|
| `selectModel(source, promptChars)` | Returns the model id for a task. Base tier comes from the `UsageSource` label; large prompts (≥ 12 k / ≥ 40 k chars) bump the tier up toward `capable`. |
| `escalate(modelId)` | Returns the next-stronger model in the ladder (`haiku → sonnet → opus`), or `null` at the top. Used by `runClaude` / `streamChat` to retry failed or weak-output tasks. |

`authoring` (code-authoring runs) maps to `capable` (Opus) unconditionally — unlike `review` (ambient deep-enrichment), it is user-initiated (approve-to-start) and runs at most once per approved intent rather than unattended on a heartbeat, so the cost/quality tradeoff favors the strongest tier.

---

## `usage.ts` — Usage recorder

Thin wrapper around `dbInsertUsage` so `claude.ts` doesn't import the DB layer directly. All errors are swallowed — telemetry never breaks an AI call.

**Key exports:**

| Export | Description |
|---|---|
| `recordUsage(source, model, cliResult)` | Persist a `usage_events` row from a CLI result object |

---

## `budget.ts` — Daily spend guard

Gates the ambient deep-enrichment path (the single largest driver of Opus spend) against a configured daily USD cap. Never gates user-initiated calls.

**Key exports:**

| Export | Description |
|---|---|
| `isOverDailyBudget()` | Returns `true` once today's total `usage_events` cost (all sources/models, via `dbGetUsageSummary('today')`) reaches `AmbientConfig.dailyBudgetUsd` (falls back to `DEFAULT_CONFIG.ambient.dailyBudgetUsd`, `2.0`; `0` disables). Errors are swallowed → treated as under budget. Checked once per ambient cycle (not per hit) in `runAmbientCycle`. |

---

## `mcp.ts` — MCP client manager

Manages MCP server connections (stdio, HTTP, SSE) using `@modelcontextprotocol/sdk`. See [mcp-and-oauth.md](mcp-and-oauth.md) for details.

Transport is selected from `McpServerConfig.transport` (`'stdio' | 'http' | 'sse'`); defaults to `'stdio'` when `command` is present, `'http'` otherwise. HTTP/SSE servers require `cfg.url`; optional `cfg.headers` carries auth tokens. The stderr ring buffer is stdio-only.

**Key exports:**

| Export | Description |
|---|---|
| `connectServer(cfg)` | Connect a single MCP server (stdio, HTTP, or SSE) and cache it |
| `disconnectServer(name)` | Gracefully disconnect and remove from cache |
| `connectAllServers()` | Connect all **enabled** servers from config (`enabled !== false`); serialized via mutex; disabled servers are explicitly disconnected |
| `reconnectServer(name)` | Test or restore a named server under the mutex; returns `McpServerStatus`. Non-destructive when already connected: probes the live client with `listTools`; only falls back to a full reconnect if the probe fails or the server was not in the Map. Used by Settings "Test connection". |
| `disconnectAllServers()` | Disconnect all active connections |
| `callTool(server, tool, params)` | Call a tool on a connected server; flattens result to string; throws when `result.isError` is set |
| `callToolRaw(server, tool, params)` | Like `callTool` but returns the raw MCP result (`{ content, isError? }`) without flattening or throwing; used by `mcp-bridge.ts` |
| `getServerStatus()` | Return `McpServerStatus[]` from the in-memory Map; returns `{ disabled: true }` for servers with `enabled === false` |
| `ensureServersConnected()` | Best-effort reconnect of any configured, enabled server not currently in the live Map; called before MCP-enabled chat turns |

---

## `logger.ts` — Persistent file logger

Append-only file logger that writes structured lines to `~/.mypa/mypa.log`. All writes also mirror to `console` so dev-terminal output is unchanged. A 1 MB size cap triggers a half-truncation on the next write (retains the newest half). Dependency-free.

**Key exports:**

| Export | Description |
|---|---|
| `logInfo(scope, msg)` | Write an informational line (`[scope] msg`); mirrors to `console.log` |
| `logError(scope, msg, err?)` | Write an error line with optional Error stack; mirrors to `console.error` |

---

## `mcp-bridge.ts` — In-process Agent SDK bridge

Wraps the warm `mcp.ts` connection pool as in-process MCP proxy servers for the Agent SDK's `{ type: 'sdk', instance }` variant. Eliminates the per-chat cold-boot cost (no subprocess spawns for chat turns). See [mcp-and-oauth.md](mcp-and-oauth.md#mcp-in-the-agent-sdk) for the full design.

Each `CallToolRequest` handler applies two hardening layers before returning to the SDK's embedded MCP client (which may be an older `@modelcontextprotocol/sdk` version than mypa's):
1. **try/catch**: a thrown `callToolRaw` (timeout, dead connection) is converted to a valid `{ content, isError: true }` result and logged via `logger.ts` instead of propagating as an opaque protocol error.
2. **Normalization**: strips `structuredContent`, `_meta`, and non-text/non-image content variants from the result before returning, so the response shape is stable across SDK versions.

**Key export:**

| Export | Description |
|---|---|
| `buildBridgedMcpServers()` | Returns `Record<string, { type: 'sdk'; name: string; instance: Server }>` — one entry per connected pool server, keyed by sanitized name. Each proxy serves `tools/list` from the cached tool list (in-process, no round-trip) and forwards `tools/call` to the live client via `callToolRaw`. Disconnected servers are absent. |

---

## `cron.ts` — Scheduler

Wraps `node-cron` to schedule and manage routine execution.

**Key exports:**

| Export | Description |
|---|---|
| `startScheduler()` | Load all enabled routines and schedule them |
| `refreshSchedules()` | Re-read routines from DB and reschedule (called on create/update/delete) |
| `scheduleRoutine(routine)` | Schedule a single routine |
| `unscheduleRoutine(id)` | Cancel and remove a routine's task |
| `stopScheduler()` | Cancel all scheduled tasks (app shutdown) |

On fire, each task calls `executeRoutine(routine, widgetWin)` from `routines.ts`.

---

## `routines.ts` — Routine execution

Orchestrates the full MCP → Claude → notification pipeline for a routine run.

**Key exports:**

| Export | Description |
|---|---|
| `executeRoutine(routine, widgetWin)` | First calls `supersedePriorRuns(routine.id)` (below) so a new run replaces any prior untouched run of the same routine; then gathers data (agentically via `runRoutineAgent`, or via the legacy static actions loop — see step 1 below); on all-failure marks run `error` + emits a failure flag; on partial failure prepends error preamble to inference input; on success runs digest + intent pipeline |
| `supersedePriorRuns(routineId)` (internal) | Finds prior `routine_runs` for `routineId` still in `pending_response`/`error` (never `in_progress` — the user is already engaged, so it's left alone) and flips each to `status:'dismissed'`, broadcasting `routine:run-completed` per row so `useLiveRuns` moves it to the archived list live; calls `updateBadgeCount()` once if anything was dismissed. Runs on every scheduled fire and manual "Run now" — a routine firing on a multi-value cron (e.g. `0 9,17 * * *`) or on separate schedules never leaves more than one unhandled run in "Needs Attention." |
| `handleRunMessage(runId, userMsg)` | Streaming follow-up chat on a run thread; broadcasts `routine:user-message` before streaming |
| `dismissRun(runId, status)` | Mark a run as resolved/dismissed |

**Execution steps (Phase B):**
1. Gather data. If `routine.prompt` is non-empty (the normal case): any *non*-read-only entry in `routine.actions` is executed directly via `callTool` first — exactly as the old static loop did, since a routine can be explicitly configured to perform a write (e.g. "post to #eng") and that must still happen. Then `runRoutineAgentForRoutine(routine)` builds a system/user prompt from the routine's own `prompt` field (plus, if present, the *read-only* `routine.actions` entries as an optional non-authoritative hint of which server/tools are relevant — never replayed verbatim) and calls `runRoutineAgent` (`agent.ts`) so Claude drives the read-only MCP tool calls itself, chaining a list-style call's real results into later per-item detail calls. The agent's `failures` are folded into `rawOutput` (as `"[server.tool] ERROR: message"` lines, matching the old loop's inline format) so `generateRoutineDigest` in step 3 doesn't lose visibility into partial failures. Legacy routines with an empty `prompt` fall back to the old static loop in full: `callTool(action.server, action.tool, action.params)` for each `routine.actions` entry, independently, with no data-flow between actions. Every path tracks the same shape: `successCount` increments per successful tool call; `failures[]` accumulates `{ server, tool, message, authFailure }` on error. `isAuthFailure(err)` matches 401/403/expired-token patterns.
   - This replaced a design where the static actions list was the *only* execution path: an authoring LLM (`generateRoutineSetup`) had to bake every param up front with no runtime data available, so "for each item returned by the list call, fetch its detail" routines shipped with frozen placeholder params (e.g. a hardcoded `pull_number: 0`) that always failed against the real API. See the 2026-07-14 changelog entry.
2. **All-failed branch** (`successCount === 0 && failures.length > 0`): mark run `status:'error'` with an auth-aware summary, fire a failure OS notification, skip inference entirely, emit one non-LLM `type:'flag'` `IntentObject` via `routeIntent` so the failure appears in the insight feed non-actionably (no Send/Approve CTA).
3. **Partial-failure / success branch**: `generateRoutineDigest` → persist `{ summary, body }` digest + chat message. `extractCoveredEntities(rawOutput)` → `covered_entities`. `inferRoutineIntents(name, inferenceInput)` where `inferenceInput` prepends an error-preamble for any partial failures so the model treats them as observations, not actions. `routeIntent(obj, 'routine', ...)` for each — tier resolution, DB persist, graph node, notify.
4. OS notification (digest `summary`) + push events to both windows.

---

## `plan.ts` — Plan item lifecycle

**Key exports:**

| Export | Description |
|---|---|
| `createPlanDraft(intent)` | Delegates to `generatePlanDraft` in `claude.ts` |
| `confirmPlanDraft(draft)` | Persists the draft as a `PlanItem`, mirrors it into the graph as a `plan_item` node with `targets` edges to referenced entities |
| `updatePlanItemStatus(id, status)` | Update status; appends to `plan_item_history` |
| `deletePlanItem(id)` | Delete item and cascade |
| `handlePlanMessage(itemId, userMsg)` | Streaming chat on a plan-item thread; assembles a context packet (task self-context + memory/graph packet via `assembleContextPacket('plan_chat', ...)`) and passes it as `rawContext` to `streamChat` so the model starts aware of the task and related work; broadcasts `plan:user-message` before streaming |

---

## `config.ts` — Config file management

Reads and writes `~/.mypa/config.json`. See [configuration.md](configuration.md) for the full config shape.

**Key exports:**

| Export | Description |
|---|---|
| `ensureConfigDir()` | `mkdir -p ~/.mypa/` |
| `readConfig()` | Read config, deep-merge with `DEFAULT_CONFIG`, decrypt secrets |
| `writeConfig(config)` | Encrypt secrets, write config |
| `updateConfig(partial)` | Deep-merge partial update, write, return updated config |
| `getOwnerHandles()` | Flat list of configured owner handles (non-empty, trimmed) — used for graph-render tagging |
| `targetIsOwner(target)` | Returns `true` when a free-text target string (e.g. from LLM output) resolves to the owner; exact, normalised comparison against `owner.name` + all surface handles — used by the self-target guard in `ambient.ts` |
| `buildOwnerClause()` | Returns a one-sentence system-prompt instruction addressing the owner as "you"; returns `''` when `AppConfig.owner` is not set |

Secrets encrypted at rest:
- `mcp_servers[].env.*` values — MCP server API keys / tokens
- `oauth_apps[provider].clientSecret` — OAuth client secrets

Encryption uses Electron `safeStorage`; encrypted values are stored with an `enc:` prefix so unencrypted values remain readable on systems where `safeStorage` is unavailable.

---

## `oauth.ts` — OAuth flows

Handles authentication with GitHub, Notion, and Linear. See [mcp-and-oauth.md](mcp-and-oauth.md) for details.

**Key exports:**

| Export | Description |
|---|---|
| `handleOAuthCallback(url)` | Called on `mypa://oauth/callback` — validates `state` nonce, exchanges code for token |
| `startDeviceFlow()` | Begin GitHub device flow; returns `DeviceFlowStart` |
| `pollDeviceFlow(deviceCode)` | Poll until token issued; returns access token |
| `startPkceFlow(provider)` | Generate PKCE verifier + challenge, return authorization URL |

---

## `ambient.ts` — Ambient polling loop

Runs the recurring background poll cycle (default every 5 minutes). Reads config, calls each surface's trigger evaluator, generates intents, pushes `ambient:*` events to the renderer, and updates tray state.

**`refreshTray`/digest-ready reach both windows:** `refreshTray(win)` (internal) and the `ambient:digest-ready` push in the time-trigger cron callback both call `broadcast(...)` (from `../windows`), not `win.webContents.send(...)` — so the tray-state signal and the digest-ready signal reach the widget *and* the main window, matching every other `ambient:*` channel. `win` is still accepted by `refreshTray` for signature parity with its other internal callers but is otherwise unused.

**Start gate:** `startAmbient()` requires at least one ingestion surface configured — either an MCP server for `github`/`jira`/`slack`/`linear`, or `knowledge.vault.enabled` (the Obsidian vault has no MCP server, so it's checked separately). A module-level `ambientRunning` flag makes `startAmbient()` idempotent (a no-op if already running, or if still gated), so `ipc-handlers.ts`'s `config:update` handler calls it on *every* update rather than only on an `ambient.enabled` false→true transition — this is what makes newly adding the first surface (first MCP server, or newly enabling the vault) take effect immediately instead of requiring an app restart. (`scheduleTimeTriggers`, one of `startAmbient`'s internal steps, is not itself idempotent — it would leak orphaned cron tasks if called twice — which is why the top-level guard exists rather than relying on each sub-timer's own guard.)

**Vault signals never generate proactive intents:** `onNewSignals` (and `ambientPollNow`) filter `surface === 'obsidian'` signals out before `evalEventTriggers`. This is a correctness requirement, not just an emergent property of vault signals lacking `actor`/`relation`/`directed` — `evalSpike` fires on raw signal *volume* per `surface:kind`, regardless of relation, so a bulk vault import or a flurry of note edits would otherwise look like a spike. Vault signals still get ingested into the graph (`ingestSignalIntoGraph`) and embedded, so they surface as context via `semanticSignals`; they just never trigger inference on their own.

**Key exports (non-IPC):**

| Export | Description |
|---|---|
| `routeIntent(obj, triggerKind, contextPacket, focusNodeIds, win)` | Route an already-inferred `IntentObject` through the full tier/DB/graph/notify pipeline (mute check → scope check → `enrichPayloadForRouting` → `guardSelfTarget` → `dbCreateIntent` → graph node → `handleIntent`). Used by `routines.ts` to feed routine-generated action candidates into the same queue as ambient intents. |
| `reviseIntentFromChat(id)` | One-shot re-proposal over the Chat thread: loads `intent_chat_threads` history → calls `reproposeIntent` with a synthetic instruction → if above confidence/urgency floors, applies proposal via `dbReproposeIntent` → appends assistant reply to chat thread → broadcasts `ambient:chat-message` + `ambient:intent-updated`. Returns `{ intent, applied, message }` or null on error. |
| `revalidatePendingIntents()` (internal) | Freshness revalidation: for each pending intent, maps work-item focus nodes to their `signals` rows, checks whether the surface has completed a successful non-truncated poll after the intent was created, and whether the signal was absent from that poll. Requires 2 consecutive misses (tracked in `intentMissCount`) before expiring the intent. Broadcasts `ambient:intent-updated` with `status: 'expired'` and refreshes the tray. Surface-agnostic — works for any adapter. |
| `surfaceIntent(intentId, win)` (internal) | Shared surfacing path for all tiers: marks intent `surfaced`, broadcasts `ambient:intent-created`, and (for `type='action'`) fires an OS `Notification` + `updateBadgeCount()`. Previously tier-3 had a separate early-return path that skipped the notification and badge. |

---

## `autonomy.ts` — Trust tier engine

Manages the `autonomy_policy` table and the promotion/demotion of action-type tiers. Handles approve/challenge/dismiss outcomes and updates consecutive-approval streaks used for automatic tier promotion.

**Two-level tier resolution:** `resolveTier(obj)` looks up the earned per-`surface:verb` policy first, then falls back to the intent-type-level policy (what the user set in Settings for e.g. all "action" intents), then to the hardcoded default (tier 2). This means user Settings choices are live defaults that earned trust can refine on top of.

**Promotion/demotion bounds:** `AUTO_DECAY_FLOOR = 1` prevents automatic trust accumulation from falling below tier 1 (Notify) — reaching tier 0 (Silent) requires explicit Settings opt-in. Symmetrically, `AUTO_ESCALATE_CEILING = 2` prevents challenge feedback from raising a verb above tier 2 (Approve) — reaching tier 3 (Locked) requires explicit Settings opt-in. `setTier` records `tier_locked = true` whenever tier 3 is explicitly set, making explicit Locks distinguishable from challenge drift (which always has `tier_locked = false` since it caps at tier 2).

---

## `triggers.ts` — Trigger evaluators

One evaluator per `TriggerKind` (`waiting`, `spike`, `staleness`, `dependency`, `time`). Each evaluator queries the graph/signals DB and returns candidate `TriggerHit`s passed to `inference.ts`.

The `waiting` (structural) trigger replaces the old regex-driven `directed` trigger. `evalWaitingOnMe(newSignals)` fires on inbound signals where `directed=1` (assigned, review-requested, mentioned, or DM/thread-replied); `evalWaitingOnMeFromGraph()` is the heartbeat variant that queries `dbGetDirectedSignals` from persisted data. The `staleness` trigger (now called `evalStaleAndMine`) is restricted to owner-assigned or review-requested nodes. The `directed` TriggerKind and `evaluationCount % 6` gate were removed in the 2026-06-11 "Needs me" reframe. `evalThreshold` and the `evalStaleness` alias were removed (dead code — neither was imported in any call path).

---

## `ingestion.ts` — Signal ingestion pipeline

Coordinates the flow from raw API payloads to structured `Signal` rows and graph entries. Deduplicates by `(surface, external_id)`. Calls `ingestSignalIntoGraph` from `memory-graph.ts`.

`SurfaceAdapter.poll()` now returns `{ observations: RawObservation[]; complete: boolean }`. `complete` must be `true` only when no query hit its page/count limit (GitHub `per_page` raised to 50). `runAdapterPoll` records `lastCompletePollAt` per surface when `complete=true` and no error occurred. `getLastCompletePollAt(surface)` is exported for use by `revalidatePendingIntents()` in `ambient.ts`.

**Supported surfaces:** GitHub, Jira, Slack, Linear, Obsidian. The `adapters` array contains one adapter per surface. `STAGGER_OFFSETS` staggers each surface's initial poll: `{ github: 0, jira: 20_000, slack: 40_000, linear: 60_000, obsidian: 80_000 }`.

**Linear adapter:** `makeLinearAdapter()` polls `linear_get_user_issues` (returns plain text, not JSON). `parseLinearIssueText(text)` splits on `\n- IDENTIFIER:` boundaries and extracts `priority`, `status`, and `url` from the following lines. Issues are stored as `linear:issue:<identifier>` nodes with `relation: 'assigned'` and `directed: true`. `scrubRaw` strips all fields except `['identifier', 'status', 'priority', 'url']`.

**Obsidian adapter:** `makeObsidianAdapter()` reads a local markdown vault directly via `fs` — the only adapter with no MCP server (`serverName: ''`). `isAvailable()`/`poll()` read `AppConfig.knowledge.vault`; when disabled, unset, or the path is missing, `poll()` returns `{ observations: [], complete: true }` (a no-op, not an error). `poll()` walks the selected folders for `.md` files, builds a vault-wide basename → relative-path index (for resolving `[[wikilinks]]`, which Obsidian addresses by note name rather than path), strips YAML frontmatter (capturing `tags`), and derives the title from the first H1 or the filename. One signal per note (`kind: 'note'`), fingerprinted on a content hash (not mtime, which vault re-indexing can touch without a real edit) *plus* the resolved `wikilinks` list — so a note re-processes both when its own text changes, and when a `[[link]]` target that didn't exist yet at ingest time is later created (the source note's text never changes, so the content hash alone wouldn't catch this). `raw` carries `{ tags, wikilinks, folder }` for `memory-graph.ts` to consume — see [knowledge-graph.md](knowledge-graph.md#knowledge-vault-obsidian) for how these become graph nodes/edges and why vault signals are excluded from proactive triggers.

---

## `inference.ts` — Intent generation

Takes a `ContextPacket` (assembled by `memory-graph.ts`) and produces scored `Intent` candidates that are persisted to the `intents` table and surfaced in the renderer.

**Key exports:**

| Export | Description |
|---|---|
| `inferIntent(hit, packet?)` | Single-intent inference from a `TriggerHit`; returns `InferIntentResult { obj, dropReason? }`. Urgency floor is now per-kind: `waiting`/`staleness` → `waitingUrgencyFloor` (default 0.25); others → `urgencyFloor` (default 0.5). |
| `inferRoutineIntents(name, rawOutput, maxIntents?)` | Multi-intent inference over routine MCP output; returns up to `maxIntents` (default 3) `IntentObject`s as a JSON array parsed from one Claude call |
| `reproposeIntent(intent, thread, userMessage)` | Re-proposal with live read-only MCP: injects the original `context_packet`, the current proposal, and the full conversation history into a prompt, calls `runClaudeWithMcp`, and returns `{ message: string, intent: IntentObject }` parsed from a JSON envelope |
| `parseIntentObject(text)` | Parse + validate a raw JSON string into an `IntentObject`; clamps unknown verbs to `'none'` |
| `inferDeepIntent(hit, packet?)` | Agentic deep-enrichment for directed-at-me items. Before the standard write-action proposal, tries an **author-fix** path (see `tryProposeAuthorFix`, same file): if the triggering item's container resolves to a `RepoLink` (via `repos.ts` `resolveRepoForNode`) with authoring enabled, runs a read-only decision call that judges whether a coding agent could plausibly attempt the task and, if so, writes a self-contained `task_description`. On `proceed: true` this short-circuits with an `author_fix`-verb `IntentObject` instead of the usual comment/review proposal; on `proceed: false` (or no linked repo) it falls through to the existing `actions[]` proposal. |

---

## `repos.ts` — Repo links (code-authoring targets)

Maps external work-item containers (a GitHub `owner/repo`, a Jira project key) to a local git checkout the user has registered in Settings, so mypa knows where to run code-authoring work. `RepoLink`s live in `AppConfig.repos` (`config.json`), not the DB — registration is a config mutation, not a signal-derived fact.

**Key exports:**

| Export | Description |
|---|---|
| `getAllRepoLinks()` / `getRepoLink(id)` | Read from `config.repos` |
| `addRepoLink(localPath, jiraProjectKeys)` | Validates `localPath` is a git repo (`.git` dir present), then shells out to `git remote get-url origin` and `git symbolic-ref .../HEAD` to prefill `githubRepo` and `defaultBaseBranch`. Never clones or writes to the checkout. |
| `updateRepoLink(id, patch)` / `removeRepoLink(id)` | Config mutations |
| `resolveRepoForSignal(signal)` | Matches a `Signal`'s container to a `RepoLink` with `authoringEnabled`, reusing the same owner/repo and Jira-project-key parsing as `deriveContainer` in `memory-graph.ts` |
| `resolveRepoForNode(key, url?)` | Same match, but from a graph-node key (`surface:kind:external_id`) instead of a full `Signal` row — used by `inference.ts`, which only has focus nodes from the context packet at hand |

---

## `worktree.ts` — Isolated git worktrees for authoring

Creates and tears down disposable git worktrees so a code-authoring run never touches the user's real checkout. All operations shell out to `git` via `execFile` — no native git library dependency.

**Key exports:**

| Export | Description |
|---|---|
| `createWorktree(repoLink, taskKey)` | `git fetch origin <baseBranch>`, then `git worktree add -b mypa/<slug> <path> origin/<baseBranch>` at `~/.mypa/worktrees/<repo>/<slug>/`. Returns `{ worktreePath, branch, baseBranch }`. |
| `captureDiff(worktreePath)` | `git add -A` (safe — the worktree is disposable) then reads `--stat`, `--name-only`, and the full patch from the staged diff. Does not commit. |
| `commitAndPush(worktreePath, branch, message)` | Commits the staged changes and pushes the branch to `origin` — called only once the user taps "Ship it". |
| `pruneWorktree(repoLocalPath, worktreePath, branch, abandon)` | `git worktree remove --force`, falling back to `git worktree prune` + filesystem cleanup if the worktree metadata is already gone; deletes the local branch too when `abandon` is true |

---

## `authoring.ts` — Code-authoring lifecycle

Orchestrates an `author_fix` intent from approval through shipping. See [code-authoring.md](code-authoring.md) for the full design and the `work_products` data model.

**Key exports:**

| Export | Description |
|---|---|
| `startAuthoring(intentId)` | Idempotent. Resolves the intent's `RepoLink`, creates a worktree, runs `runAuthoringAgent` (`agent.ts`), captures the diff, and creates/updates a `work_products` row (`drafting` → `ready`/`failed`). Marks the intent `approved` as a side effect of the user tapping "Start". |
| `getWorkProductForIntent(intentId)` | Read |
| `shipWorkProduct(intentId)` | Pushes the branch, opens the PR (`github:create_pull_request`), and comments on the originating ticket — the ticket identifiers come only from the trusted triggering signal (`inference.ts` `deriveTrustedTicketRouting`), never from the author-fix decision model's own output. Validates required fields for every planned step before any external call runs; a failing step after the PR exists is recorded on the work product (with the `pr_url` it already has) rather than lost. On full success, marks the intent `executed` and records trust via `autonomy.ts recordExecution(`${surface}:author_fix`)` — the same `${surface}:${verb}` key convention every other verb uses (not a bespoke key). There is deliberately no Slack (or other) ship-time notification — see [code-authoring.md](code-authoring.md) for why. |
| `discardWorkProduct(intentId)` | Prunes the worktree (if one exists) and dismisses the intent via `ambient.ts ambientDismissIntent` — a one-way dependency (`ambient.ts` never imports `authoring.ts`) that keeps the existing execution paths in `ambient.ts` untouched. |

---

## `embeddings.ts` — Local embeddings

Generates text embeddings using [`@huggingface/transformers`](https://huggingface.co/docs/transformers.js) (transformers.js v3) entirely on-device (no network call). Used by `memory-graph.ts` to build semantic similarity edges. The model is loaded quantized (`dtype: 'q8'`) from the HuggingFace hub and cached at `~/.mypa/models`. All inference is serialized through a single promise chain (`embeddingQueue`) to prevent concurrent ONNX runs.

**Key exports:**

| Export | Description |
|---|---|
| `MODEL_NAME` | The model identifier string (`Xenova/all-MiniLM-L6-v2`) |
| `embedText(text)` | Returns a normalized 384-dim Float32Array (or null on model-not-ready) |
| `cosineSim(a, b)` | Dot product of two pre-normalized unit vectors |
| `floatToBlob(v)` | Serialize a Float32Array to a Buffer for SQLite BLOB storage |
| `blobToFloat(blob)` | Deserialize a BLOB column value to Float32Array |
| `enqueueEmbeddings(signals)` | Fire-and-forget: embed new signals in the background queue |
| `enqueueBackfill()` | One-time startup drain: embed all signals missing an embedding |
| `enqueueMemoryBackfill()` | One-time startup drain: embed all active memories missing an embedding; called from `startAmbient` alongside `enqueueBackfill` |

---

## `memories.ts` — Memory CRUD and summarization

Orchestrates periodic memory extraction from recent signals and graph context. After each `dbCreateMemory` call the content's embedding is persisted via `dbSetMemoryEmbedding` so future dedup reads from BLOB storage instead of re-running ONNX inference. `findSuperseded` accepts a pre-computed query vector and reads each candidate's stored BLOB via `dbGetMemoryEmbedding`, falling back to live `embedText` only for unbackfilled rows.

---

## `memory-graph.ts` — Knowledge graph construction

The core of the ambient intelligence pipeline. See [knowledge-graph.md](knowledge-graph.md) for the ontology and data-flow details.

**Key exports:**

| Export | Description |
|---|---|
| `ingestSignalIntoGraph(signal)` | Map a signal to nodes/edges; bump weights; link timeline |
| `kindToNodeType(kind)` | Map a signal kind string to a `NodeType` (`'note'` → `'document'`) |
| `deriveWikilinkEdges(signal, workItemNodeId)` | Obsidian-only: resolves `raw.wikilinks` to `document` nodes and adds `references` edges. Idempotent (checks existing edges first) — safe to call twice, which `ambient.ts` relies on for resolving forward references within an import batch. |
| `buildSimilarityEdges()` | Embed top-12 node labels, link pairs with cosine similarity > 0.82 via `similar_to` edges |
| `applyDecay()` | Hourly half-life decay on node and edge weights |
| `assembleContextPacket(triggerKind)` | Build a `ContextPacket` from recent signals, top nodes, related edges, and memories |
| `renderPacketForPrompt(packet)` | Serialize a `ContextPacket` to a prompt-ready string |

---

## `memory-export.ts` — Memory export

Builds a self-contained Markdown export of all memories and the full knowledge graph, suitable for direct LLM ingestion and migration. Called by the `memory:export-markdown` IPC handler.

**Key export:**

| Export | Description |
|---|---|
| `buildMemoryExportMarkdown(memories, nodes, edges)` | Returns a Markdown string with migration prompt, human-readable memories (grouped by type), graph nodes + edges, and a JSON data appendix |

---

## `claude-import.ts` — Claude Code config import

Reads an existing Claude Code config file (typically `~/.claude.json` or `~/Library/Application Support/Claude/claude.json`) and returns `DetectedMcpServer[]` that can be imported into mypa's MCP server list.

---

## `updater.ts` — Auto-update

Wraps `electron-updater` to check GitHub Releases for a newer version of mypa. Only active in packaged builds (`app.isPackaged`); silently skipped in dev mode to avoid errors without a live feed.

**Behaviour:**
- `hasUpdateConfig()` checks for `Contents/Resources/app-update.yml` before doing anything else — that file is only written by electron-builder when a build actually produces the mac zip/dmg (or win nsis / linux AppImage) target, so a `--dir` build (e.g. the `unpack` skill's `npm run pack`) never has it. `initUpdater` no-ops (with a console log) if it's missing, so a dir-mode install never schedules background checks; `checkForUpdatesNow()` pushes a clear `update:error` message instead of letting `autoUpdater.checkForUpdates()` throw a raw `ENOENT` on the missing file.
- First check runs 30 s after startup to avoid blocking cold start
- Subsequent checks every 4 hours via `setInterval`
- Downloads automatically (`autoDownload = true`)
- On download complete: calls `setUpdateReady(true)` in `tray.ts` (switches "Check for Updates" → "Restart to Update" in the tray menu) and pushes `update:downloaded` to all renderer windows

**Key exports:**

| Export | Description |
|---|---|
| `initUpdater(getWindow)` | Wire up events and start the check schedule |
| `checkForUpdatesNow()` | Manually trigger an update check (from tray menu or IPC) |
| `installUpdate()` | Call `autoUpdater.quitAndInstall()` to apply the downloaded update |

**electron-builder publish config** (`package.json` `build.publish`): GitHub, repo `adobecom/mypa`. The CI workflow uploads `*.dmg`, `*.zip`, `*.blockmap`, and `latest-mac.yml` to each GitHub Release. `electron-updater` reads `latest-mac.yml` to detect new versions and downloads the `.zip` for the in-place update.

---

## `checkin.ts` — PA check-in sessions

Manages structured 1:1 check-in sessions between the user and the agent. Generates an opening briefing from the knowledge graph, handles streaming chat, and runs a post-session knowledge extraction pass that commits new memories, node weight adjustments, and edges directly to the graph.

**Key exports:**

| Export | Description |
|---|---|
| `startCheckIn(trigger, win)` | If an active session exists and the user has already replied to it, returns that session unchanged (never wipes a live conversation). Otherwise — no active session, or an active one with only the opening briefing and no user reply yet — supersedes it (`status:'dismissed'`, `checkin:status-changed` broadcast) and creates a fresh session, streaming the opening briefing |
| `handleCheckInMessage(checkinId, userMessage, win)` | Send a user message, stream response |
| `endCheckIn(checkinId)` | Mark as extracting, run knowledge extraction async, update status |
| `cancelCheckinStream(checkinId)` | Cancel an active stream by session ID |

**Knowledge extraction:** After `endCheckIn`, a non-streaming Claude pass reads the full thread and returns JSON with `memories[]`, `weight_adjustments[]`, and `new_edges[]`. Each is validated and applied to the DB via existing graph/memory functions.

**Config:** `AppConfig.checkin.scheduleEnabled` + `AppConfig.checkin.schedule` (cron). Scheduling is wired through `cron.ts` (`refreshCheckinSchedule`).

## Changelog

- 2026-07-15 — **Fix "stopped mid-response" on write-tool approvals and `ask_user` questions (`agent.ts`).** Responding in a chat with MCP write tools enabled (this reliably hit routine-run chats, since their digest is action-oriented) could time out ~140s into waiting for a human to approve a write-tool call or answer an `ask_user` question — surfacing `'The assistant stopped mid-response. Please try again.'`, with `Tool permission request failed: Error: Tool permission stream closed before response received` in `~/.mypa/mypa.log`. Root cause: both blocking human-response awaits (`canUseTool`'s write-approval branch, `buildAskUserServer`'s answer wait) yield no SDK messages while pending, so nothing called `resetIdle()` — the idle timer (armed to `STREAM_STARTUP_TIMEOUT_MS` by the preceding `mcp_tool_use` message) fired, `ac.abort()` closed the SDK subprocess's stdin, and the CLI rejected the still-outstanding permission/question request with that message. Fix: `streamAgentChatOnce` now tracks a `humanWaits` counter (`beginHumanWait`/`endHumanWait`); its idle-fire handler re-arms instead of aborting while `humanWaits > 0`. `buildAskUserServer` takes an optional `hooks: { begin, end }` param threaded from the call site. Cancellation (Stop button, teardown) is unaffected — those paths still resolve pending approvals/questions immediately. A follow-up hardening pass (same commit, from review) bounds the re-arming with a 30-minute absolute cap (`HUMAN_WAIT_HARD_CAP_MS`) so a wait nobody ever resolves — dismissed without Stop, or a colliding concurrent approval — still eventually aborts, and adds a `stopped` guard against a smaller timer leak on teardown. Full root-cause trace and ruled-out causes in [claude-integration.md](claude-integration.md#changelog).

- 2026-07-15 — **A newer routine run / check-in supersedes an old undealt-with one (`routines.ts`, `checkin.ts`, `types.ts`, `CheckInPage.tsx`).** Previously every scheduled tick created a new `routine_runs` row unconditionally, so a routine firing more than once a day (e.g. 9 AM and 5 PM PR review) left a stale `pending_response`/`error` run sitting in "Needs Attention" alongside the new one. `routines.ts` `executeRoutine` now calls a new internal `supersedePriorRuns(routineId)` first — it dismisses (`status:'dismissed'`, broadcasting `routine:run-completed` per row) any prior run of the same routine still in `pending_response` or `error`; a run the user is already chatting into (`in_progress`) is deliberately left alone so an active conversation is never wiped out. `dbGetRunsForRoutine` (existing) supplies the candidates; no schema change (`RunStatus` already had `'dismissed'`). Check-ins had the mirror bug in the opposite direction: `startCheckIn` used to *block* a new session and hand back the old active one unconditionally. It now only does that if the existing session has a user reply already (`dbGetCheckInThread(...).some(m => m.role === 'user')`); an untouched active session (just the opening briefing) is instead dismissed (new `CheckInStatus` value `'dismissed'` in `types.ts`, `checkin:status-changed` broadcast) before the new one is created. `startCheckIn` also calls `cancelClaudeStream(existing.id)` before dismissing — the superseded session's opening-briefing stream may still be in flight, and without cancelling it, its `.then()` continuation could still land a stray assistant message into the now-`dismissed` row moments after the UI already labeled it superseded. `CheckInPage.tsx` gained a page-level `checkin:status-changed` listener (previously only `CheckInDetail`, mounted per expanded row, listened — so a dismiss firing on a row that isn't expanded, the common case here, never reached the list) and disables sending a message into a `dismissed` session's `ChatThread`. See [renderer.md](renderer.md#changelog) for the renderer-side changelog entry and [ipc.md](ipc.md) for the updated `checkin.start`/`checkin:status-changed` descriptions.

- 2026-07-14 — **Fix widget/main-window state divergence — `ambient:tray-state` and `ambient:digest-ready` were widget-only (`ambient.ts`).** Every other `ambient:*` push channel goes through `broadcast(...)` (both renderer windows), but `refreshTray(win)` and the digest-ready send in the time-trigger cron callback did `win.webContents.send(...)` against the single window passed in — and the routine-completion path passes `widgetWin`, so the main window never received either event, even though nothing in it currently listens for `ambient:tray-state` (only the widget's tab strip does). Fixed for consistency with every other `ambient:*` channel and so a future main-window tray indicator or digest-refresh hookup doesn't need its own broadcast fix. `ambient:digest-ready` does have a real main-window consumer today (`DigestView`, mounted inside `InsightsPage`), so that half of the fix does change observable behavior. Both now call `broadcast(...)`. The reported "Needs you" list going stale while open was a separate, renderer-side bug — see [renderer.md](renderer.md#shared-hooks) for that fix (shared live-data hooks + focus-refetch).

- 2026-07-14 — **Agentic scheduled routine runs — fix frozen placeholder params (`agent.ts`, `routines.ts`, `claude.ts`, `model-router.ts`, `types.ts`, `UsageDashboard.tsx`, `RoutineForm.tsx`).** Root cause: a scheduled routine's `actions` was a static, flat list of MCP tool calls executed independently (`callTool(action.server, action.tool, action.params)` in a plain loop, no data-flow between steps). The authoring LLM (`generateRoutineSetup`) had to bake every param up front with no runtime data available, so a "list PRs, then fetch each one's status/files" routine shipped with a hardcoded placeholder like `pull_number: 0` for every per-PR call — GitHub returns 404 for a nonexistent PR #0, which the (deprecated) `@modelcontextprotocol/server-github` rewraps as `MCP error -32603: Not Found`, surfacing as a routine-wide "blocker" even though the MCP token/connection was perfectly healthy. Fix: `agent.ts` gains `runRoutineAgent(systemPrompt, userPrompt, timeoutMs?)` — an agentic MCP run (read-only tools only via `isReadOnlyTool`, now exported; `maxTurns: 15`; MCP servers from the warm bridge pool via `ensureServersConnected`/`buildBridgedMcpServers`, not cold-spawned) that reconstructs `{ text, rawOutput, successCount, failures }` from the SDK message stream by indexing each `tool_use` block by id and resolving the matching `tool_result` (success or `is_error`) back to `{ server, tool }`. A final `is_error` result with at least one already-gathered tool result returns that partial data instead of discarding it — covers hitting `maxTurns` mid-chain on a long list, the exact shape this fix targets. `routines.ts` `executeRoutine` Step 1 now calls `runRoutineAgentForRoutine(routine)` whenever `routine.prompt` is non-empty; any *non*-read-only entry in `routine.actions` is still executed directly via `callTool` first (the agentic step is deliberately read-only, so a routine explicitly configured to perform a write would otherwise have it silently denied — the old static loop executed any tool unconditionally), and the agent's `failures` are folded back into `rawOutput` (matching the old loop's inline error format) so the digest step doesn't lose visibility into partial failures. Routines with an empty `prompt` (legacy) still run the old static loop unchanged. The `allFailed` gate was also corrected from `routine.actions.length > 0 && successCount === 0 && failures.length > 0` to just `successCount === 0 && failures.length > 0` — the `actions.length` guard was redundant for the static path (failures can't be nonzero if the loop never ran) and was actively wrong for the agentic path, where `routine.actions` can legitimately be empty. `claude.ts` `generateRoutineSetup`'s prompt now tells the authoring LLM that `actions` is only an optional hint (not a replayed call sequence) and explicitly forbids inventing placeholder IDs/numbers — per-item dependencies must be described in `prompt` instead, since that's the only place an agentic run reads its instructions from. New `UsageSource` value `'routine_run'` (`types.ts`) mapped to `'capable'` (Opus) in `model-router.ts`, matching `suggest`/`authoring`. `UsageDashboard.tsx`'s `humanizeSource` map and `RoutineForm.tsx`'s actions/prompt labels updated to match the new semantics.

- 2026-07-13 — **Onboarding polish: Keychain auth detection, add-tool debounce, dynamic identity surfaces, draggable window during setup (`auth.ts`, `OnboardingWizard.tsx`, `ServerCatalogPicker.tsx`, `App.tsx`/`index.css`, `mcp.ts`, `Settings.tsx`, `types.ts`).** Four first-run rough edges fixed together: (1) `resolveAuthSource()` now also checks the macOS Keychain (`security find-generic-password -s "Claude Code-credentials"`, bounded with a 2s `timeout` since this runs synchronously on the main process and an unauthorized-ACL Keychain prompt could otherwise block it indefinitely) so a `claude login` session is detected even without `~/.claude/.credentials.json` — see [claude-integration.md](claude-integration.md#authentication). (2) `OnboardingWizard.handleAddServer` gained a `serversAddedRef`/`addingServerRef` guard so a rapid double-click can no longer race two `config.update` calls off a stale `serversAdded` closure — and now rethrows after its error toast, so `ConfigurePanel`/`ImportPanel`/`CustomServerPanel`'s existing `await onAdd(...); onBack()` correctly stays on the panel (with the user's input intact) instead of navigating away as if the add had succeeded. The catalog's `ConfigurePanel` "Add {name}" button now has a `saving` spinner state matching `ImportPanel`/`CustomServerPanel`, instead of being clickable repeatedly with no feedback. (3) The "About you" step no longer hard-codes a fixed 5-surface grid (github/slack/jira/linear/notion) — it now only shows a handle input for a surface if an enabled MCP server with that name was added during onboarding (or the surface already has a saved handle), following the same filtering pattern as Settings' `OWNER_SURFACES`/`visibleSurfaces`; an empty-state hint shows when no tools are connected. The surface vocabulary itself was previously duplicated four ways (`types.ts`, `mcp.ts`'s `SURFACE_NAMES`, `Settings.tsx`'s `OWNER_SURFACES`, and a new onboarding-local copy) — consolidated into a single exported `IDENTITY_SURFACES`/`IdentitySurface` in `@shared/types.ts`, imported (and locally aliased to keep existing call sites unchanged) by all three. (4) The main window had no `-webkit-app-region: drag` region until onboarding completed (the only drag region lives on `.sidebar`, which isn't rendered pre-onboarding) — a new `.drag-strip` top strip is rendered during the loading and onboarding states so the frameless (`titleBarStyle: 'hiddenInset'`) window can be moved from the start. It's a normal flex item (real layout space), not an absolutely-positioned overlay — an overlay would sit on top of the scrollable wizard content below it, making anything scrolled into that 44px band unclickable (reachable on step 3's tool catalog, which regularly exceeds the default 960×700 window height). See [renderer.md](renderer.md#onboarding-wizard).

- 2026-07-13 — **Friendlier auto-update failure on unbuilt/dir-mode installs (`updater.ts`).** A build installed via the `unpack` skill (`npm run pack`, i.e. `electron-builder --dir`) never contains `Contents/Resources/app-update.yml` — electron-builder only writes it as a side effect of building the mac zip/dmg (or win nsis / linux AppImage) target, which `--dir` skips. Previously this surfaced as a raw `ENOENT ... app-update.yml` toast on "Check for Updates," indistinguishable from a real update failure. New `hasUpdateConfig()` checks for the file up front: `initUpdater()` no-ops silently (with a console log) instead of scheduling background checks doomed to fail, and `checkForUpdatesNow()` pushes one clear `update:error` message explaining the build wasn't installed from a signed release, instead of the raw stack. Real `npm run dist` / GitHub Release builds are unaffected — verified the file is present by mounting a locally built `.dmg`.

- 2026-07-13 — **Obsidian vault knowledge source (`ingestion.ts`, `memory-graph.ts`, `ambient.ts`, `config.ts`/`types.ts`, `ipc-handlers.ts`/preload, Settings.tsx).** A local markdown vault (e.g. Obsidian) can now be ingested as a read-only context layer, scoped to user-selected subfolders — a personal vault's non-work notes stay out of the graph. New `makeObsidianAdapter()` in `ingestion.ts` (no MCP server; reads `fs` directly, gated by `AppConfig.knowledge.vault`), registered in `adapters[]` and `STAGGER_OFFSETS`. `memory-graph.ts` gains a `'note'` → `'document'` mapping in `kindToNodeType`, an `obsidian` branch in `deriveContainer` (folder container as a `document` node), and a new idempotent `deriveWikilinkEdges` turning `[[wikilinks]]` into `references` edges. The obsidian fingerprint (`ingestion.ts` `poll()`) includes the note's resolved `wikilinks` list alongside its content hash, so a link that only becomes resolvable once its target note is created later still triggers re-processing on the next poll (content hash alone wouldn't change). `ambient.ts` factors the shared "ingest batch → second-pass wikilink resolution" logic into `ingestSignalsAndResolveWikilinks(signals)` and the obsidian trigger-exclusion filter into `nonVaultSignals(signals)`, both called from `onNewSignals` (scheduled polling) and `ambientPollNow` (manual poll) — the second pass re-runs `deriveWikilinkEdges` once every note's node in the batch exists (resolves same-batch forward references), and `nonVaultSignals` explicitly excludes obsidian signals from `evalEventTriggers` (vault notes must never look like a spike or generate proactive intents). New `IntentSurface` value `'obsidian'`, intentionally excluded from `VALID_SURFACES` (inference.ts) and from the `runMemorySummarization` surface list (memories.ts). New Settings "Knowledge Vault" section (path picker + folder checkboxes) and `knowledge:list-vault-folders` IPC channel. Also fixed a pre-existing gap this surfaced: `startAmbient()` gained an `ambientRunning` idempotency guard, and `config:update` (`ipc-handlers.ts`) now calls `startAmbient()`/`stopAmbient()` based on current `ambient.enabled` state on every update instead of only on a false→true transition — previously, adding the very first ingestion surface (MCP server or, now, an enabled vault) while `ambient.enabled` was already `true` silently required an app restart to take effect. See [knowledge-graph.md](knowledge-graph.md#knowledge-vault-obsidian), [configuration.md](configuration.md), and [ipc.md](ipc.md).

- 2026-07-09 — **Security review follow-up on the code-authoring slice (`inference.ts`, `authoring.ts`, `agent.ts`).** Fixed several issues a code-review + security-review pass surfaced before this shipped: (1) `inference.ts` `parseAuthorFixDecision`'s `task_description` field was being run through `sanitizeRationale` — built for a one-line field, it cuts at the first sentence and clamps to 300 chars — silently truncating the multi-sentence brief handed to the authoring agent down to one sentence; replaced with a dedicated `sanitizeTaskDescription` (whitespace collapse + 4000-char clamp only). (2) The ship-time ticket/comment destination was taken directly from the author-fix decision model's own JSON output; new `deriveTrustedTicketRouting` now derives it only from the trusted triggering graph node (mirroring `enrichPayloadForRouting` in `ambient.ts`), and the model-chosen Slack-notification step + `reviewers` field were removed entirely rather than shipped unvalidated. (3) `authoring.ts` `startAuthoring` now calls `recordApproval` and appends an `approved`/`failed` `action_log` entry on start/failure (it previously only updated intent status, silently diverging from the documented approve-flow parity); `shipWorkProduct` now records execution under the same `${surface}:${verb}` key every other verb uses instead of a hardcoded `'repo:author_fix'` string that no policy lookup ever read. (4) `shipWorkProduct`'s failure message no longer claims "failed before opening a PR" when the branch had already been pushed. (5) `agent.ts`'s `canUseTool` now confines `Grep`/`Glob` to the worktree by path (previously unconditionally allowed) and `BASH_DENY_RE` gained `git ls-remote` and common network/DNS tools; `isWithinWorktree` now fails closed on a missing `file_path` instead of allowing it through. (6) `discardWorkProduct` now refuses while an authoring run is in flight in the current process (new in-memory `inFlightAuthoring` guard), and `WorkProductCard.tsx` gained a Discard button for `drafting`/`failed` work products that previously had no recovery path (a `failed` work product also makes the intent terminal, the same convention every other verb uses, but the button was gated behind `!isTerminal` and never rendered).

- 2026-07-09 — **Code-authoring: `author_fix` intent → isolated worktree → diff review → ship (`repos.ts`, `worktree.ts`, `authoring.ts` new; `agent.ts`, `inference.ts`, `model-router.ts`, `ambient.ts` touched only via a one-way import).** First slice of the "investigate → fix → ship" vision — see [code-authoring.md](code-authoring.md). New `repos.ts` maps a linked local checkout (`RepoLink`, stored in `AppConfig.repos`) to a signal's GitHub repo / Jira project. New `worktree.ts` creates a disposable git worktree + branch per attempt (`~/.mypa/worktrees/<repo>/<slug>/`) so authoring never touches the user's real checkout. `agent.ts` gains `runAuthoringAgent` — the only call site in the file that grants built-in `Bash`/`Edit`/`Read`/`Write`/`Grep`/`Glob` tools, gated by a `canUseTool` that confines writes to the worktree and blocks network/push/clone/remote. New `authoring.ts` orchestrates the lifecycle (`startAuthoring` → `shipWorkProduct`/`discardWorkProduct`) against a new `work_products` DB table (see [database.md](database.md)). `inference.ts` `inferDeepIntent` tries an author-fix decision path first (read-only) when a directed trigger's container resolves to an authoring-enabled `RepoLink`; on `proceed:true` it emits an `author_fix`-verb intent instead of the usual comment/review proposal. `author_fix` intents default to tier 2 (approve-to-start) via the existing `TYPE_DEFAULT_TIER['action']` — no `ambient.ts` tier-resolution changes were needed. `authoring.ts` imports `ambientDismissIntent` from `ambient.ts` for the discard path; `ambient.ts` itself was not modified and does not import `authoring.ts`, so the existing intent execution paths (`executeIntent`/`executeActions`) are untouched. New `'authoring'` `UsageSource` maps to `capable` (Opus) in `model-router.ts`. New widget `WorkProductCard.tsx` renders in place of `IntentCard` for `author_fix` intents (see [renderer.md](renderer.md)); new Settings "Repos" section (see `Settings.tsx` `ReposSection`).

- 2026-07-08 — **Cost reduction: downgrade `'review'` to Sonnet, daily budget cap, same-tier JSON retry (`model-router.ts`, `budget.ts` new, `agent.ts`, `ambient.ts`).** New `budget.ts` service (`isOverDailyBudget()`) gates ambient deep-enrichment against `AmbientConfig.dailyBudgetUsd`. `model-router.ts` `SOURCE_TIER['review']` moved from `'capable'` to `'balanced'` — see [ambient-intelligence.md](ambient-intelligence.md) changelog for the full rationale (this one source was ~97% of Opus spend). `agent.ts` `runAgentOnce` now retries once at the same model tier with a stricter JSON-only instruction before throwing the error that triggers tier escalation, reducing unnecessary Haiku→Sonnet climbs on merely-malformed (not under-capable) responses.

- 2026-07-07 — **Hardening pass: ambient polling backoff, secret redaction, quit-safety, MCP call typing.** `ingestion.ts` — `startIngestion`'s per-adapter poll loop switched from a fixed `setInterval` to a self-rescheduling `setTimeout` chain with geometric backoff (capped at 4x the base interval) on consecutive `runAdapterPoll` failures, resetting on the next success; an `ingestionEpoch` counter (bumped by `stopIngestion`) invalidates any in-flight reschedule so a poll that's mid-flight when ingestion is stopped can't resurrect a "zombie" timer after `intervalIds` is cleared. Also fixed a real bug: the Jira adapter read `readConfig().mcpServers` (doesn't exist — the field is `mcp_servers`), so JIRA_URL-based base-URL reconstruction always silently no-op'd. `logger.ts` — `redact()` now scrubs common secret shapes (Bearer tokens, GitHub/Slack tokens, API keys) from both the file-written line and its console mirror, since MCP tool error/response payloads are logged verbatim and could echo a token from a misconfigured server. `usage.ts` — `recordUsage()`'s catch block now calls `logError` instead of swallowing silently; a DB-write failure there previously left cost/usage under-reporting with zero trace. `config.ts` — `encryptValue()` now logs a one-time warning via `logError` when `safeStorage.isEncryptionAvailable()` is false, instead of silently falling back to plaintext secret storage. `mcp.ts` — `callTool`/`callToolRaw` factored into a shared `callToolTimed()` helper (both were duplicating an identical `withTimeout(...) as CallToolResult` cast, needed because piping the SDK's `Client.callTool()` through the generic `withTimeout<T>` wrapper collapses its inferred return type to `{}`); `withTimeout` is now exported for reuse by `index.ts`'s quit-cleanup path; `disconnectAllServers()` changed from a sequential `for` loop to `Promise.allSettled`, since a caller bounding it with an overall timeout (see below) would otherwise only reach as many servers as fit in loop order before the deadline. `index.ts`/`ipc-handlers.ts` — the tray "Quit" callback and OS-initiated `before-quit` previously each duplicated cleanup and called the async `disconnectAllServers()` without awaiting it, orphaning in-flight MCP child processes; unified into one `cleanupAndExit()` that awaits disconnect (bounded to 3s via `withTimeout`) before `app.exit(0)`, with `event.preventDefault()` called unconditionally on every `before-quit` (not gated behind the re-entry guard) so a second quit trigger arriving while cleanup is still in flight can't let Electron's default quit proceed early. The same bounded-disconnect pattern was applied to `system:factory-reset`, which had the identical unbounded-hang risk. `windows.ts` — `widgetWin` now nulls itself on `'closed'` (matching `mainWin`'s existing pattern) and both `BrowserWindow`s set `sandbox: true` explicitly.

- 2026-07-01 — **Bridge hardening, tool-error logging, and persistent file logger (`mcp-bridge.ts`, `agent.ts`, `logger.ts` new).** Root-cause fix for MCP tool calls in routine chat producing confabulated "ZodError in the permission wrapper" model diagnoses. (1) New `logger.ts` — append-only file logger writing to `~/.mypa/mypa.log` with 1 MB size-cap rotation; `logError(scope, msg, err?)` and `logInfo(scope, msg)` mirror to `console` so dev-terminal output is unchanged. (2) `mcp-bridge.ts` `CallToolRequestSchema` handler — wraps `callToolRaw` in try/catch (thrown calls, e.g. 30 s pool timeout, now return `{ content, isError: true }` and are logged instead of propagating as an opaque protocol error); normalizes the result to text/image-only content (strips `structuredContent`, `_meta`, non-standard variants) so the shape is valid against any `@modelcontextprotocol/sdk` version embedded in the native binary. (3) `agent.ts` — both `streamAgentChatOnce` and `runAgentWithMcpOnce` now inspect `user`-type SDK messages for `tool_result` blocks with `is_error: true` and log them via `logError('agent', …)`. Previously the only record of a tool failure was the model's narrative, which is documented to confabulate ZodError/schema/session diagnoses.

- 2026-06-30 — **Fix routine failures producing self-targeted "Send" intents (`routines.ts`, `config.ts`, `ambient.ts`, `inference.ts`).** Three-layer fix. (1) `routines.ts` `executeRoutine`: added `isAuthFailure(err)` classifier (matches 401/403/expired-token patterns). Step 1 loop now tracks `failures[]` and `successCount` in addition to `rawOutput`. On all-failed: marks run `status:'error'` with an auth-aware message, fires a failure OS notification, skips `inferRoutineIntents` entirely (primary fix), and emits one non-LLM `type:'flag'` via `routeIntent`. On partial failure: prepends an error preamble to `inferenceInput` so the model treats failed steps as observations. (2) `config.ts` `targetIsOwner(target)`: new predicate — normalised exact match against `owner.name` + all surface handles. (3) `ambient.ts` `guardSelfTarget(obj)`: new function called after `enrichPayloadForRouting` in both `runAmbientCycle` and `routeIntent`; converts any `slack:send`/`slack:reply` whose `proposed_action.target` resolves to the owner into a `type:'flag'` so no Send/Approve CTA is shown. Root cause: a Jira 401 was silently swallowed into `rawOutput`, then `ROUTINE_SYSTEM_PROMPT`'s "STRONGLY PREFER type:action" directive + `buildOwnerClause` (naming the owner as the only person in context) caused the LLM to fabricate a self-targeted Slack send.

- 2026-06-30 — **Fix non-Adobe signal ingestion + scope gate activation (`memory-graph.ts`, `ingestion.ts`, `config.ts`, `scope.ts`, `db/index.ts`):** Four-part fix restoring the intended Adobe-only scope enforcement. (1) `deriveContainer` in `memory-graph.ts` — replaced `signal.raw.repository.full_name` lookup (never present in GitHub `search_issues` responses) with URL-based parsing: new `parseGithubOwnerRepo(url)` helper extracts `owner/repo` from `html_url` first, then falls back to `repository_url` API field, then legacy webhook fields. This causes `repo` container nodes and `part_of` edges to be correctly created so `scope.ts:violatesScope` can compare against the allowlist. (2) `ingestion.ts` scrubRaw allowlist — added `'repository_url'` so the API field is preserved on the stored signal for the fallback path. (3) GitHub poll `ingestion.ts:poll()` — reads `config.scope?.allowed?.github` at poll time and appends `org:<x>` qualifiers to all four search queries; empty list = no filter (backward compatible). (4) `seedScopeIfUnset()` exported from `config.ts` — idempotent one-time seed called in `index.ts` after `initDb()` that writes `scope.allowed.github=['adobecom']` when no scope has ever been configured, ensuring the filter is active immediately for affected users. New `dbGetNodesByType(type)` added to `db/index.ts` for the candidate builder. New `buildScopeCandidates()` exported from `scope.ts` — enumerates distinct org/project/channel identifiers from the knowledge graph (falling back to `pull_request`/`issue` node URLs for GitHub before `repo` nodes exist) and unions with the current configured allowlist, for use by the Settings scope multi-select UI.

- 2026-06-30 — **Fix Slack read tools misclassified as writes (`agent.ts`):** Added `READ_ONLY_TOOL_NAMES` set to `isReadOnlyTool` as an explicit override for Slack tool names (`conversations_history`, `conversations_replies`, `conversations_unreads`) that lack a read-verb prefix component. See `claude-integration.md` for full details.

- 2026-06-27 — **Strip built-in tools from streaming/MCP paths; EPIPE guard (`agent.ts`, `index.ts`):** `streamAgentChatOnce` and `runAgentWithMcpOnce` now pass `tools: []` to `query()`, disabling Bash/Edit/Write and all other built-in tools. Chat and one-shot MCP calls use MCP tools + `ask_user` only. This fixes a hang where the model would call Bash during PR-review chat, `canUseTool` would await an approval card the renderer cannot surface for a non-MCP tool, and the 140 s idle timer would eventually fire with "The assistant stopped mid-response." `canUseTool` also now cleanly denies any non-`mcp__server__tool` name before entering the approval flow (defense-in-depth). `src/main/index.ts` gains `process.on('uncaughtException')` and `process.on('unhandledRejection')` handlers registered before `main()` — the exception handler suppresses benign `EPIPE` errors from the SDK subprocess's stdin (previously popped as Electron OS dialogs) and routes genuine errors to `console.error` + `dialog.showErrorBox` in packaged builds.

- 2026-06-26 — **Proactive agentic deep-enrichment (`inference.ts`, `ambient.ts`, `triggers.ts`, `autonomy.ts`, `agent.ts`, `model-router.ts`).** `TriggerHit` gains `relation?: Signal['relation']` (set in `buildWaitingHit`). New `isDeepEligible(hit)` predicate in `triggers.ts` returns true for `review_requested`/`assigned`/`mentioned` waiting items. `runAmbientCycle` routes eligible hits to `inferDeepIntent` (new, `inference.ts`) instead of `inferIntent`; falls back on error; caps at `MAX_DEEP_PER_CYCLE = 2` per cycle. `inferDeepIntent` builds a prompt with focus-node URLs and the live server+tool list, calls `runClaudeWithMcp` (source `'review'`), and validates the `actions[]` array against `getToolInputSchema`. New `executeActions(intent)` in `ambient.ts` loops `intent.actions[]` calling `callTool(server, tool, params)` — no verb maps required. `executeIntent` delegates to `executeActions` when `intent.actions?.length > 0`. `ambientApproveIntent` merges edited draft into `actions[0].params` via `dbUpdateIntentActions`. `actionTypeOf` in `autonomy.ts` keys on `actions[0].server:tool` when `actions` is present. `resolveTier` gains a destructive-tool regex heuristic. `isReadOnlyTool` in `agent.ts` generalized to match any component (not just the first). `'review'` added to `UsageSource` → `'capable'` (Opus).

- 2026-06-26 — **Eliminate MCP cold-boot in chat (`mcp.ts`, `mcp-bridge.ts`, `agent.ts`):** New `callToolRaw` export in `mcp.ts` returns raw `CallToolResult` without flattening (sibling to `callTool`). New `src/main/services/mcp-bridge.ts` with `buildBridgedMcpServers()` — creates one in-process `Server` proxy per connected pool entry, serving `tools/list` from cached tools and forwarding `tools/call` via `callToolRaw`. `streamAgentChat` in `agent.ts` now calls `await ensureServersConnected()` + `buildBridgedMcpServers()` instead of building stdio/http/sse configs — the SDK receives `{ type: 'sdk', instance }` servers and never spawns subprocesses for chat turns.

- 2026-06-25 — **MCP transport generalization + enable/disable + isError + Linear ingestion.** `mcp.ts`: `connectServer` branches on `McpServerConfig.transport` (`'stdio' | 'http' | 'sse'`); uses `StreamableHTTPClientTransport` and `SSEClientTransport` from `@modelcontextprotocol/sdk` for URL-based servers; stderr ring buffer is stdio-only. `callTool` now throws when `result.isError` is set. `connectAllServers` skips servers with `enabled === false` (and calls `disconnectServer` for them). `getServerStatus` returns `{ disabled: true }` for disabled servers. Dead code removed: `lastKnownTools` Map and `getKnownServerTools()` export (CLI-era `--allowedTools` path). `agent.ts`: `sdkMcpServers` build loop handles `http`/`sse` transports with url+headers; skips disabled servers. `claude-import.ts`: `supported` now true for http/sse entries; `url` field forwarded. `ingestion.ts`: added `makeLinearAdapter()` + `parseLinearIssueText()` helper for plain-text Linear output; `STAGGER_OFFSETS.linear = 60_000`. `ambient.ts`: `VERB_TO_TOOL` and `AUTO_EXECUTABLE` extended with `linear:comment`; `enrichPayloadForRouting` and `buildToolArgs` gain linear branches.

- 2026-06-25 — **Fix "Stream timed out" on observation chat — tool-call idle (`agent.ts`):** Follow-up to the startup-budget fix. After the model emits a `tool_use` block, the SDK awaits the MCP server response with no messages flowing — the 120 s inter-chunk timer was firing before the result arrived. `resetIdle()` now accepts an optional `ms` parameter; when a `tool_use` block is detected in an assistant message, a second `resetIdle(STREAM_STARTUP_TIMEOUT_MS)` call re-arms the timer with 140 s so the tool round-trip has the same budget as the cold-spawn startup.

- 2026-06-25 — **Fix "Stream timed out" on observation chat — startup budget (`agent.ts`):** Split the single `STREAM_IDLE_TIMEOUT_MS = 120_000` into a startup budget (`STREAM_STARTUP_TIMEOUT_MS = 140_000`) and a steady-state inter-chunk idle timeout (still 120 s). `streamAgentChatOnce` now arms the first timer with 140 s when MCP is enabled, then `resetIdle()` re-arms at 120 s after the first message lands. This covers the Agent SDK's cold-spawn of stdio MCP subprocesses before the first chunk. The 140 s value stays below the renderer's 150 s safety backstop in `IntentCard.tsx`. When `rawContext` is set, the system prompt also includes a nudge to answer links/IDs from context without tool calls.

- 2026-06-25 — **Harden SDK harness: timeout race, null-result logging, write-word guard (`agent.ts`):** three pre-existing issues fixed. (1) Removed post-loop `if (timedOut)` checks from `runAgentOnce`, `runAgentWithMcpOnce`, and `streamAgentChatOnce` — if the loop exits cleanly, the response is valid regardless of timer state. (2) Added `console.warn` before the null-resultMsg throw for observability. (3) Added `WRITE_WORDS` blocklist to `isReadOnlyTool` to prevent tools like `fetch_and_update` from passing the read-prefix filter.

- 2026-06-25 — **Fix one-shot "Reached maximum number of turns (3)" (`agent.ts`):** added `tools: []` to `runAgentOnce` options so no built-in tools appear in the model's context; dropped `maxTurns` from `3` to `1`. Previously the full Claude Code tool preset was offered and `canUseTool: deny` handled each attempt reactively — each denied attempt burned a turn, exhausting `maxTurns: 3` before text was produced. Fixes routine digest failures and all other `runClaude`/`runAgent` callers.

- 2026-06-25 — **Ground plan-item chat in memory/graph context packet (`plan.ts`, `shared/types.ts`).** `handlePlanMessage` now assembles a `rawContext` string before the `streamChat` call: the plan item's own title/detail/actions are prepended as a self-context block, then `assembleContextPacket('plan_chat', ['plan_item:<id>'])` + `renderPacketForPrompt` append the full memory/graph packet (relevant memories, focus graph node, related edges, recent signals, semantic matches). `rawContext` is passed as the 5th arg to `streamChat` (previously always `undefined`). Assembly is best-effort — if it throws, chat falls back to ungrounded behavior. Added `'plan_chat'` to the `TriggerKind` union in `src/shared/types.ts` so the packet's trigger label is accurate. `dbGetPlanItem`, `assembleContextPacket`, and `renderPacketForPrompt` added to `plan.ts` imports. This closes the "blank slate" gap that made manual plan-item chat behave like a Claude session with no memory.

- 2026-06-24 — **Fix `spawn ENOTDIR` in packaged app (`agent.ts`):** added `resolveClaudeExecutable()` helper (memoized, module-private) that rewrites `app.getAppPath()` to the `app.asar.unpacked` sibling path so the SDK's bundled binary can be spawned from inside the asar. All three `query()` call sites now pass `pathToClaudeCodeExecutable: resolveClaudeExecutable()`. Imports `app` from `electron`, `existsSync` from `fs`, `path`.

- 2026-06-22 — **New `auth.ts` service; `detectClaudeBin` removed:** added `src/main/services/auth.ts` with `buildAgentEnv()` (returns `{ ...process.env, ANTHROPIC_API_KEY }` when a key is stored, or `undefined` to inherit ambient creds) and `resolveAuthSource()` (priority probe: stored key → env var → `~/.claude/.credentials.json` → none). All three `query()` call sites in `agent.ts` now pass `env: buildAgentEnv()`. `detectClaudeBin()`, `nvmClaudePaths()`, `npmGlobalBin()` and their `execSync`/`readdirSync` imports removed from `claude.ts` — no subprocess is needed for auth probing or inference.

- 2026-06-22 — **Inference: empty-sentinel guard + Jira URL reconstruction (`inference.ts`, `ingestion.ts`).** (1) `isEmptySentinel(obj)` helper added to `inference.ts` — detects when the model copies the "nothing actionable" fallback template with a non-zero confidence (bypassing the confidence floor) by checking `type==='flag' && verb==='none' && (rationale==='nothing actionable' || target==='nothing')`. Applied before all other floor checks in both `inferIntent` and `inferRoutineIntents`; drops with a new `'empty-sentinel'` discriminant in `InferIntentResult.dropReason`. (2) `makeJiraAdapter` poll in `ingestion.ts` now reconstructs the URL when `i.url` is absent: reads `JIRA_URL` from the configured `jira` MCP server's env and builds `${JIRA_URL}/browse/${key}`. This flows through `normalize()` → `signals.url` → graph-node `attrs.url` → `context_packet`, enabling clickable links on Jira intent cards.

- 2026-06-22 — **Agent SDK migration complete:** added `agent.ts` as the new AI entry point (`@anthropic-ai/claude-agent-sdk`); `claude.ts` is now a thin shim layer forwarding `runClaude` → `runAgent`, `streamChat` → `streamAgentChat`, `cancelStream` → `cancelAgentChat`; subprocess spawn code removed from `claude.ts`; removed `stageChatActionsFromSegment`, `executeChatAction`, and `ACTION_BLOCK_RE` from `ambient.ts` (superseded by SDK `canUseTool` gating).

- 2026-06-19 — **Chat write-action correctness + plan-chat parity (`ambient.ts`, `plan.ts`, `claude.ts`, `db/index.ts`, `db/schema.ts`).** Four fixes: (1) `MCP_CHAT_SYSTEM_ADDENDUM` rewritten — the model is told emitting an `<action>` block only queues the write (never posts it) and must say "queued for approval" rather than claiming success. `github:approve` added to the valid pairs list. (2) Typed approval: at the start of `handleIntentChat` and `handlePlanMessage`, `findLatestPendingAction` + `isAffirmative`/`isDismissal` detect a short affirmative/dismissal reply ("go ahead", "approve", "yes", "no", "cancel", etc.); if a pending action is in the thread, `approveChatAction`/`dismissChatAction` is called directly and the function returns without streaming — the chip flips to `executed`/`dismissed` and a confirmation note is appended. (3) Action-state rendered into model history: `rawHistory` is mapped before being passed to `streamChat`; messages with a `.action` field get their empty `content` replaced with a synthetic status line (`[proposed github:comment — status: pending, awaiting the user's Approve/Dismiss (NOT yet executed)]`), so the model has accurate state and stops hallucinating "done". (4) `github:approve` verb: `VERB_TO_TOOL.github` gains `approve → create_pull_request_review`; `buildToolArgs` GitHub branch gains an `approve` case producing `{ owner, repo, pull_number, event: 'APPROVE', body? }`; routing falls back to model-provided `owner`/`repo`/`issue_number`/`pull_number` when `_`-prefixed injected values are absent. Plan-chat parity: `stageChatActionsFromSegment` extracted as an exported shared helper from the intent-chat action-processing block; `handlePlanMessage` now calls it for every segment (strips action tags, stages chips) instead of saving raw segments. `approvePlanAction`/`dismissPlanAction` added to `ambient.ts` (mirrors intent equivalents; no `action_log` entry). `plan_item_threads` gains `metadata TEXT` column (additive migration). `dbAddPlanMessage`/`dbGetPlanThread`/`dbUpdatePlanMessageMetadata` in `db/index.ts` updated to handle the new column.

- 2026-06-18 — **Fix: chat hang + Jira arg mapping (`claude.ts`, `ambient.ts`, renderer).** Two bugs fixed: (1) `runClaudeStream` lacked a timeout — the only Claude spawn path without a watchdog. Added `STREAM_IDLE_TIMEOUT_MS = 120_000` and an idle timer (reset on every stdout chunk) that kills the subprocess and rejects with `'Stream timed out'` if no output arrives for 120 s. `streamChat` now treats this error as terminal (no escalation retry), matching the `'Cancelled'` guard. (2) `buildToolArgs` Jira branch (`ambient.ts`) was returning only `{ issue_key, comment }` but the live `mcp-atlassian` tool's `inputSchema.required` includes `body`, causing a pre-flight failure even when the comment text was present. Fixed by returning both `comment` and `body` set to the same value. Client-side 150 s safety backstop added to `IntentCard.tsx`, `PlanItemCard.tsx`, and `PlanItemDetail.tsx`: if `done:true` never arrives, the streaming indicator clears and shows a friendly "stopped responding" error.

- 2026-06-18 — **Fix: challenge tier drift + missing action button (`autonomy.ts`).** Added `AUTO_ESCALATE_CEILING: Tier = 2` constant (symmetric to `AUTO_DECAY_FLOOR = 1`). `recordChallenge` now caps at this ceiling: the condition changed from `policy.tier < 3` / `Math.min(3, ...)` to `policy.tier < AUTO_ESCALATE_CEILING` / `Math.min(AUTO_ESCALATE_CEILING, ...)`. Challenge feedback can raise a verb to at most tier 2 (Approve); reaching tier 3 (Locked) requires explicit user opt-in via `setTier`. `setTier` updated: writes `tier_locked: locked || tier === 3` so any Settings-driven Lock is permanently marked, distinguishing it from challenge drift (which always leaves `tier_locked = 0`). The previously-unlocked tier-3 policy rows that drifted from repeated challenges are reset by a one-time normalization in `schema.ts`.

- 2026-06-18 — **Live MCP in chat + in-chat write actions (ambient.ts, claude.ts, mcp.ts).** Three layered improvements: (1) `mcp.ts` — `lastKnownTools: Map<string, McpTool[]>` persists tool names across in-process reconnects. New exports `getKnownServerTools()` (falls back to cached tools for dead clients, `stale` flag) and `ensureServersConnected()` (best-effort parallel reconnect of dead servers, errors swallowed). (2) `claude.ts` — `buildMcpInvocation()` helper extracted from `runClaudeWithMcp`; builds the `--mcp-config` temp file and `--allowedTools` allowlist using `getKnownServerTools()` (not `getServerStatus()`), so the list survives dead in-process clients. `runClaudeStream` / `streamChat` gain an optional `enableMcp?: boolean` param; when set: calls `ensureServersConnected()`, calls `buildMcpInvocation()`, appends `--mcp-config` + `--allowedTools` to the spawn args, and calls `cleanup()` in both close and error handlers. The system prompt is extended with `MCP_CHAT_SYSTEM_ADDENDUM` — tells the model it has read-only tools and how to propose writes via `<action>{...}</action>`. (3) `ambient.ts` — all `streamChat` callers (`handleIntentChat`, routines.ts `handleRunMessage`, plan.ts `handlePlanMessage`, checkin.ts both calls) pass `enableMcp: true`. `handleIntentChat` post-stream parses `<action>` blocks with `ACTION_BLOCK_RE`, strips them from visible text, merges parent-intent routing identifiers into the payload, computes the trust tier via `resolveTier`, and either auto-executes (tier 0) or persists a pending action in `intent_chat_threads.metadata`. New exports: `approveChatAction(intentId, messageId, editedPayload?)` and `dismissChatAction(intentId, messageId)` — look up message metadata, execute/skip, record trust, update metadata. New internal `executeChatAction(surface, verb, payload)` — like the execution core of `executeIntent` but takes a plain payload dict.

- 2026-06-17 — **Button trimming — merge Suggest into Chat:** `ambient.ts` — removed `ambientSuggestIntent` and `ambientGetIntentThread` (Suggest standalone flow). Added `reviseIntentFromChat(id)`: loads the `intent_chat_threads` history, calls `reproposeIntent` with a synthetic instruction ("Based on our conversation above, produce your revised proposal."), applies the result via `dbReproposeIntent` when above confidence/urgency floors, appends the assistant reply to the chat thread, and broadcasts `ambient:chat-message` + `ambient:intent-updated`. The `intent_threads` table is deprecated (no new writes; existing rows preserved). Removed `dbAddIntentMessage` and `dbGetIntentThread` imports from `ambient.ts` (no longer needed).

- 2026-06-17 — **Fix: GitHub/Jira intent actions failing with `-32603` (missing MCP args) + pre-flight guard + per-intent chat.** `ambient.ts`: (1) `enrichPayloadForRouting(obj, focusNodes)` — new shared helper replaces duplicated inline Slack enrichment in `runAmbientCycle` and `routeIntent`, and extends the same injection pattern to GitHub (parses `_owner`/`_repo`/`_issue_number` from the focus node's `url` attr) and Jira (`_issue_key` from the focus node key). (2) `buildToolArgs` extended: GitHub branch assembles `{ owner, repo, issue_number, body }` for `add_issue_comment` and `{ owner, repo, issue_number, labels }` for `add_labels_to_issue`; Jira branch assembles `{ issue_key, comment }`. All `_`-prefixed routing fields are stripped from the outgoing args. (3) Pre-flight guard in `executeIntent`: after `buildToolArgs`, reads the tool's `inputSchema` via new `getToolInputSchema(serverName, toolName)` in `mcp.ts` and checks all `required` fields are present; if not, calls `recordIntentFailure` with a clear human message instead of letting the MCP server reject with `-32603`. (4) `recordIntentFailure` helper extracted from the catch block to avoid code duplication across the guard and catch paths. (5) `handleIntentChat(intentId, message)` + `ambientGetIntentChatThread(id)` — streaming "Chat about it" conversation per intent, mirroring `handlePlanMessage` in `plan.ts`; uses `intent_chat_threads` DB table, `streamChat` with the intent's context packet as `rawContext`, and broadcasts `ambient:chat-user-message` / `ambient:chat-message` chunks. Available on all intents including failed/terminal ones.

- 2026-06-17 — **Insight↔routine run linkage (`entity-link.ts`):** new service `src/main/services/entity-link.ts` exports `extractCoveredEntities(rawOutput): CoveredEntity[]`. Scans the routine's raw MCP output against recently-seen signals (14-day window, up to 200 rows from new `dbGetRecentSignalsAllSurfaces`) to find referenced work items. Matching strategy: URL substring (primary) then word-boundary `external_id` + surface-name guard (fallback). Returns snapshots of matched signals as `CoveredEntity` objects with the same `surface:kind:external_id` key used by graph nodes and insight focus nodes. Called from `routines.ts` `executeRoutine` after `rawOutput` is collected; result persisted as `covered_entities` on the run row. Zero LLM calls — pure text scan.

- 2026-06-17 — **Automatic model selection:** added `model-router.ts` with `selectModel()` (task-source + prompt-size heuristics → tier) and `escalate()` (ladder traversal). `claude.ts` — `runClaude` uses `selectModel` for the initial model and an escalation loop on failure; new `expectJson` param triggers escalation on non-JSON responses. `runClaudeWithMcp` uses `selectModel('suggest', …)`. `runClaudeStream` / `streamChat` select the model from the source+size and escalate on pre-output failure.

- 2026-06-17 — **Fix: resolved intents re-surfaced on synthesis heartbeat (resolution cooldown).** `ambient.ts` — new `DEFAULT_RESOLUTION_COOLDOWN_MS` constant and `suppressedFocusNodeIds()` function. `suppressedFocusNodeIds` calls `dbGetResolvedIntentsSince(cutoff)` (new DB helper), iterates over terminal intents within their per-status cooldown window, and returns the union of their focus-node ids — excluding nodes whose underlying signal `observed_at` is newer than the intent's `resolved_at` (break-through for genuine new activity). `runAmbientCycle` builds `suppressed` separately from `covered` and applies an additional guard before each hit. The cycle log now reports both `C skipped (covered)` and `D skipped (cooldown)`. `src/shared/types.ts` — `AmbientConfig` gains optional `resolutionCooldownMs: Partial<Record<'dismissed'|'challenged'|'executed'|'failed'|'expired', number>>` for per-status override.

- 2026-06-17 — **Fix: tier-3 intents surfaced silently (no notification or badge).** `ambient.ts` — extracted `surfaceIntent(intentId, win)` helper that covers `dbUpdateIntentStatus('surfaced')` + `pushIntent` + optional `Notification`/`updateBadgeCount()` (for `type='action'`) + `refreshTray`. Both the tier-3 branch and the tier-1/2 fall-through in `handleIntent` now call `surfaceIntent`, replacing the tier-3 early-return path that previously skipped the notification and badge. All tier levels now alert the user equally.

- 2026-06-17 — **Durable fix: ambient always-on path was throttled into silence:** `ambient.ts` — `startSynthesisTimer` now fires an initial heartbeat tick ~75 s after boot (`synthesisInitialDelayMs`) before the recurring interval, so items already waiting on the user surface at startup instead of waiting 30 min. `runSynthesisHeartbeat` lifts `dbGetDirectedSignals()` to avoid a duplicate query and writes one `diag` action-log row per tick (readable via `ambient.getLog()`). `runAmbientCycle` now aggregates `skippedCovered` counts and inference drop-reason summaries into a single summary console log per cycle. `onNewSignals` logs when `evalEventTriggers` produces 0 hits. `inference.ts` — `inferIntent` now returns `InferIntentResult { obj, dropReason? }` so callers can aggregate drop reasons; urgency floor is per-kind (`waiting`/`staleness` → `waitingUrgencyFloor` default 0.25, others unchanged). Drop-reason `console.log` added at each drop point in both `inferIntent` and `inferRoutineIntents`. `ingestion.ts` — `runAdapterPoll` now always logs poll completion (seen count, new count, truncation flag) regardless of whether new signals were found. `triggers.ts` — `evalWaitingOnMeFromGraph` accepts an optional pre-fetched directed-signals array. `types.ts` — new `AmbientConfig` fields `synthesisInitialDelayMs` (default 75 s) and `waitingUrgencyFloor` (default 0.25).

- 2026-06-17 — **Fix "Test connection" false-negative + stderr diagnostics:** `mcp.ts` — `reconnectServer` now probes the live `listTools` on the already-connected client instead of tearing it down and rebuilding; only falls back to a full reconnect when the server is not in the Map or when the probe fails. `connectServer` changed `stderr` from `'inherit'` to `'pipe'`; a data listener re-emits each line to `process.stderr` with a `[mcp:<name>]` prefix (preserving visibility) and keeps a 30-line ring buffer; genuine `connect`/`listTools` timeouts now append the last 5 buffered lines to the error message returned to the UI.

- 2026-06-16 — **Ambient audit — bug fixes and dead-code removal:** `ambient.ts` — digest `decisions` filter corrected from `status='pending'` to `status='surfaced' && type='action' && required_approval=true` (intents transition out of `pending` immediately; the old filter produced an always-empty section). `ambientSuggestIntent` now only calls `dbReproposeIntent` when `result.intent` is present (reproposeIntent can now return message-only for sub-floor re-proposals). `inference.ts` — `reproposeIntent` applies the same `confidenceFloor`/`urgencyFloor` checks that `inferIntent` enforces; `urgency` is now forwarded into the re-validated object; `ReproposeResult.intent` is optional. `triggers.ts` — removed dead `evalThreshold` function (imported nowhere; comment falsely claimed it ran in the heartbeat), removed `evalStaleness` alias (dead; heartbeat calls `evalStaleAndMine` directly), removed unused `getOwnerHandles` import, removed stale section header. `autonomy.ts` — fixed inverted log wording: `recordApproval` said "trust raised" while the tier number was decreasing (more trust); `recordChallenge` said "trust lowered" while the tier number was increasing.

- 2026-06-16 — **MCP connection reliability:** `mcp.ts` — added `runExclusive` promise-chain mutex; `connectAllServers` and new `reconnectServer(name)` route through it; added Slack stale-config migration in `connectAllServers`; removed `testServer` (replaced by `reconnectServer`). `ipc-handlers.ts` — `config:test-mcp-server` replaced by `config:reconnect-mcp-server` + `config:reconnect-all`.
- 2026-06-16 — **Fix GitHub directedness, comment tool name, Jira/Slack parsers:** `ingestion.ts` — (1) GitHub `directed` computation extended: `assigned` and `mentioned` relations are now always `directed=1`, matching the Jira adapter's logic and the relation whitelist in `dbGetDirectedSignals`; previously only `review_requested` was unconditionally directed, so 123 `assigned` + 37 `involved` signals were invisible to the waiting trigger. (2) Jira adapter parser realigned to `mcp-atlassian`'s flat snake_case simplified dict: removed `i.fields` wrapper; reads are now `i.summary`, `i.updated`, `i.url`, `i.duedate`, `assignee.display_name`, `assignee.name`, `reporter.display_name`, and top-level `i.comments[]` (not `fields.comment.comments`); `comment.author.display_name` (snake_case). JQL simplified to `assignee = currentUser() OR reporter = currentUser()` — `watcher = currentUser()` dropped as it is often invalid on Jira Server/DC and causes the entire query to be rejected. (3) Slack `parseSlackCsv` now normalizes header keys to lowercase before indexing, so PascalCase Go field names from `slack-mcp-server` (`MsgID`, `Channel`, `UserName`, `UserID`, `ThreadTs`, `Text`, `Time`, `Permalink`) map correctly; all column reads updated to lowercase (`msgid`, `channel`, `username`, `userid`, `threadts`). `ambient.ts` — VERB_TO_TOOL GitHub `comment` mapping corrected from non-existent `create_issue_comment` → `add_issue_comment` (the correct tool name for `@modelcontextprotocol/server-github`).
- 2026-06-16 — **Filesystem MCP hardening — tilde expansion + path-type argInputs:** `mcp.ts` — added `expandTildeArgs(cfg)` helper; imports `MCP_CATALOG` and `homedir`; looks up the server's catalog entry and, for entries with `isPath` argInputs, expands a leading `~` in each directory arg to `os.homedir()` before spawning; applied in both `connectServer` and `testServer`. The stored value in `~/.mypa/config.json` is left unexpanded (portable); expansion only occurs at connect time. `ipc-handlers.ts` — `setup:get-health` updated to validate path-type args using `existsSync`/`statSync`; added `system:pick-directory` handler (native directory-picker dialog).
- 2026-06-16 — **Slack adapter rewritten for `slack-mcp-server`:** `ingestion.ts` — Slack adapter now calls `conversations_search_messages` (search by `to:<handle>` query; CSV response) and maps fields via new `parseCsvRow`/`parseSlackCsv` helpers. `ambient.ts` — Slack execution updated to `conversations_add_message` with `buildToolArgs` remapping `payload.message → text` and injecting `channel_id`/`thread_ts` from the focus node key. See `ambient-intelligence.md` and `mcp-and-oauth.md` changelogs for full detail.
- 2026-06-16 — **Onboarding hardening — MCP timeouts + config first-run guard:** `mcp.ts` — added `withTimeout` helper applied to `connectServer` (connect + listTools, 30 s each) and `callTool` (30 s) so a hung subprocess no longer blocks startup or the onboarding Auto-fill spinner forever. `config.ts` — first-run `writeFileSync` in `readConfig()` wrapped in `try/catch` so a full disk or unwritable home directory falls back to in-memory `DEFAULT_CONFIG` instead of throwing through every startup caller.
- 2026-06-16 — **Unified claude binary detection:** `claude.ts` — `findClaude()` replaced by `detectClaudeBin(): string | null` (exported) and a refactored `getClaude()` that caches only on success. Candidate list widened to include `~/.claude/local/claude` (official installer), `~/.npm-global/bin/claude`, nvm node-version bin dirs (all, enumerated via `readdirSync`, newest first), `~/.bun/bin/claude`, and a best-effort `npm prefix -g` fallback. `ipc-handlers.ts` — both `setup:check-prerequisites` and `setup:get-health` now call `detectClaudeBin()` instead of `execFileSync('/usr/bin/which', ['claude'])`, eliminating the inconsistency where the wizard gate was weaker than the runtime. `path-fix.ts` — `staticDirs` widened to include `~/.claude/local`, `~/.npm-global/bin`, `~/.bun/bin`, `~/.volta/bin`, and all nvm node-version bin dirs via the new `nvmBinDirs(home)` helper (fs enumeration, no shell).
- 2026-06-16 — **Fix invalid Jira JQL `mention` field:** `ingestion.ts` Jira adapter — replaced the non-existent JQL clause `mention = currentUser()` with `reporter = currentUser() OR watcher = currentUser()`. Full query is now `assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser() ORDER BY updated DESC`. Fixes recurring `HTTPError: Field 'mention' does not exist` from the Atlassian MCP server.
- 2026-06-15 — **Freshness revalidation — auto-expire outdated queued items:** `ingestion.ts` — `SurfaceAdapter.poll()` now returns `{ observations, complete }` (previously `RawObservation[]`); `complete=true` only when no query hit its page/count limit. GitHub `per_page` raised 20 → 50 to reduce truncation. Jira/Slack adapters track their own limits. `runAdapterPoll` records `lastCompletePollAt` per surface (in-memory `Map<IntentSurface, string>`) when `ok && complete`; `getLastCompletePollAt(surface)` exported for ambient use; map is cleared on `stopIngestion`. `ambient.ts` — added `revalidatePendingIntents()`: surface-agnostic; maps each pending intent's work-item focus-node keys to their `signals` rows via `dbGetSignalByExternal`; compares `signal.last_seen_at` against `lastCompletePollAt`; tracks consecutive misses in `intentMissCount`; after 2 misses, calls `dbUpdateIntentStatus(id, 'expired', reason)` + `dbAppendActionLog` + `broadcast('ambient:intent-updated')` + `refreshTray`. Added `startRevalidationTimer`/`stopRevalidationTimer` (interval = `pollIntervalMs`, default 5 min), wired into `startAmbient`/`stopAmbient`. `revalidatePendingIntents()` also called at end of `ambientPollNow` for immediate reconciliation after a manual poll. The `'expired'` `IntentStatus` was already declared; now it is actually assigned. Widget UI: `IntentCard` terminal label now shows `intent.error` (the reason) for expired intents. `QueueView` gains a "Recently resolved" section showing the last 5 terminal intents present in the current session's state (expired, dismissed, executed, etc.) — prevents items from silently disappearing.
- 2026-06-15 — **Persisted memory embeddings + memory backfill:** `embeddings.ts` — `MODEL_NAME` is now exported; added `enqueueMemoryBackfill()` (drains active memories with no stored embedding in batches of 100); called fire-and-forget from `startAmbient` alongside the existing `enqueueBackfill`. `memories.ts` — `findSuperseded` signature changed from `(newContent, candidates, node_id)` to `(qVec, candidates, node_id)`: the caller now computes `qVec = await embedText(content)` once, passes it in, and the function reads each candidate's stored BLOB via `dbGetMemoryEmbedding` + `blobToFloat` (falling back to live `embedText` only for unbackfilled rows); after `dbCreateMemory` the query vector is persisted via `dbSetMemoryEmbedding`. This removes up to 5 live ONNX inferences per summarization run once embeddings are warm.
- 2026-06-11 — **"Needs me" reframe (ingestion + triggers + inference + ambient):** `ingestion.ts` — GitHub adapter replaced two broad `involves:@me` queries with four role-tagged queries (review_requested/assigned/mentioned/involved); adds `fetchLatestCommentActor` helper (up to 15/poll, tool name confirmed from live `getServerStatus().tools`); `last_actor` included in `change_fields` so new comments change the fingerprint and re-trigger evaluation. Jira adapter adds `duedate/priority/issuelinks` to JQL fields; curated `raw.fields` sub-object un-deads `deriveAssigneeEdges` and dependency edges; latest comment body populates signal `body`. Slack adapter detects DM/mention/thread_reply structurally; `directed` set from author≠owner. `isOwnerHandle` helper added. `RawObservation` interface extended with `relation/directed/last_actor/due_at`. `runAdapterPoll` logs when `newSignals.length > 0` (no quiet-poll spam). `triggers.ts` — `evalWaitingOnMe(newSignals)` structural trigger replaces `evalDirectedAtMe`; `evalWaitingOnMeFromGraph()` variant queries `dbGetDirectedSignals` for heartbeat use; `evalStaleAndMine()` replaces `evalStaleness()` (restricts to owner-assigned/review-requested nodes); `evalThreshold` retired from autonomous path; `evaluationCount % 6` gate and counter deleted; `evalEventTriggers` simplified. `inference.ts` — `SYSTEM_PROMPT` and `ROUTINE_SYSTEM_PROMPT` gain `"urgency"` field; `parseIntentObject` extracts/clamps `urgency`; both `inferIntent` and `inferRoutineIntents` apply `urgencyFloor` filter. `ambient.ts` — `runAmbientCycle` refactored to infer-all → sort by (urgency, confidence) → take top-3 (rank-then-cap); synthesis heartbeat `startSynthesisTimer`/`stopSynthesisTimer` wired into `startAmbient`/`stopAmbient`, re-evaluates waiting+stale every 30 min from persisted signals.
- 2026-06-10 — **Scope auto-derivation from check-ins + registry-driven enforcement:** `src/shared/scope-surfaces.ts` (new) is the single registry of scope-capable surfaces (`github`/`jira`/`slack`), each carrying an `integrationId`, human label, item noun, and `parseIdentifier` function. `ScopeConfig` reshaped to `{ allowed?: Record<string, string[]> }` — a surface-keyed map replacing the three hardcoded named fields. `scope.ts` is now registry-driven: looks up `scopeSurfaceFor(surface)` and calls `spec.parseIdentifier(key)` instead of branching per surface; adds a `normalizeScopeAllowed()` shim that folds any legacy `allowedGithubOrgs`/`allowedJiraProjects`/`allowedSlackChannels` config fields into `allowed.{github,jira,slack}` for backward compatibility. `checkin.ts` — extraction schema extended with a `scope_rules` array and a matching prompt rule (held to the same absolute bar as `enforcement: "hard"`); after the `new_edges` loop, extracted scope rules union-merge new identifiers into the current `allowed` map via `updateConfig`; `CheckInExtractionSummary.scopeUpdated` count is incremented per identifier added. Autonomous summarization still never writes scope rules. To register a future scope-capable surface, add an entry to `SCOPE_SURFACES` in `scope-surfaces.ts`.
- 2026-06-10 — added `path-fix.ts` (`fixPath()`): probes the user's login shell to resolve the real `$PATH` and unions it with static Homebrew/user-local dirs; called once at the very start of `main()` in `index.ts` so packaged GUI builds find `claude`, `npx`, etc. `config.ts`: added `resetConfig()` — deletes `~/.mypa/config.json` (idempotent). `db/index.ts`: added `resetDatabase()` — closes the SQLite handle, then deletes `data.db`, `data.db-wal`, and `data.db-shm`. Both are called by the new `system:factory-reset` IPC handler (see ipc.md). `claude.ts`: hardened `findClaude()` fallback path list to include `/opt/homebrew/bin/claude` (Apple Silicon Homebrew).
- 2026-06-10 — **Suggest multi-round re-proposal:** `claude.ts` — added `runClaudeWithMcp(systemPrompt, userPrompt, source?)`: builds a temp `--mcp-config` JSON from connected MCP servers, computes a read-only `--allowedTools` allowlist (name-prefix filter: get/list/search/read/fetch/view/find/show/describe/query/lookup/check), spawns the Claude CLI with MCP wired in, and falls back to `runClaude` when no servers are live; write tools are never pre-approved. `inference.ts` — added `reproposeIntent(intent, thread, userMessage)`: constructs a re-proposal prompt from the original `context_packet`, the current proposal, and the conversation history; calls `runClaudeWithMcp`; returns a `{ message, intent }` JSON envelope parsed via `parseIntentObject`. `ambient.ts` — added `ambientSuggestIntent(id, userMessage)` (persist user message → re-propose → persist assistant reply → update proposal fields → broadcast) and `ambientGetIntentThread(id)` (returns thread from `intent_threads`).
- 2026-06-09 — `autonomy.ts`: added `isMuted(type, tier)` export (informational intent at tier 3 = muted/suppressed); `IntentType` added to imports. `ambient.ts`: both `runAmbientCycle` and `routeIntent` now call `isMuted` after `resolveTier` and skip intent creation entirely when true — muted informational intents leave no DB row, graph node, or log entry.
- 2026-06-09 — `windows.ts`: added `updateBadgeCount()` — single helper that calls `app.setBadgeCount(n)` (macOS Dock numeric badge) and `broadcast('badge:updated', n)`; replaces six scattered inline emit sites in `ipc-handlers.ts`, `routines.ts`, `plan.ts`, and `ambient.ts`; also fixes `ambient:challenge` which previously refreshed the tray but never decremented the badge; called once on startup in `index.ts` to reflect any already-pending items. `dbGetBadgeCount` imports removed from `routines.ts`, `plan.ts`, and `ambient.ts` — the helper owns that call.
- 2026-06-09 — `plan.ts`, `routines.ts`: removed `widgetWin` param from `handlePlanMessage` and `handleRunMessage`; both now broadcast `plan:user-message` / `routine:user-message` (with the saved `ChatMessage`) immediately after the DB write, before streaming; `badge:updated` changed from widget-only send to `broadcast()` in both services
- 2026-06-09 — `config.ts`: added `encryptClaude` / `decryptClaude` helpers (mirror the OAuth single-field pattern); chained into `readConfig` and `writeConfig`; added `clearClaudeApiKey()` export (explicit delete, since `deepMerge` skips `undefined`); `AppConfig.claude.apiKey` is now encrypted at rest via `safeStorage`
- 2026-06-08 — added `checkin.ts`; new exports `startCheckIn`, `handleCheckInMessage`, `endCheckIn`, `cancelCheckinStream`; `cron.ts` gains `refreshCheckinSchedule` (module-level scheduled task for periodic check-ins); `config:update` IPC handler now calls `refreshCheckinSchedule` when `checkin.*` config fields change
- 2026-06-08 — `triggers.ts`: added `directed` trigger kind; `evalDirectedAtMe` fires on single inbound signals from non-owner actors that contain question/request language; wired into `evalEventTriggers` alongside spike and dependency
- 2026-06-07 — added `updater.ts`; wraps `electron-updater` for GitHub Releases auto-update; adds `checkForUpdatesNow` and `installUpdate` exports; pushes `update:available`, `update:progress`, `update:downloaded`, `update:error` channels to all windows
- 2026-06-07 — new `usage.ts` recorder; `claude.ts` switched `runClaude` to `--output-format json` and added `source: UsageSource` param; both `runClaude` and `runClaudeStream` call `recordUsage()` after each Claude call; `streamChat` and all callers (`routines.ts`, `plan.ts`, `inference.ts`, `memories.ts`) updated with source labels
- 2026-06-07 — `routines.ts`: `routine:run-started` and `routine:run-completed` now sent via `broadcast()` (both widget + main windows) instead of widget-only `webContents.send`; `ambient.ts`: emits new `ambient:action-executed` broadcast after a tier-0 intent auto-executes successfully; added `broadcast()` helper to `windows.ts`
- 2026-06-07 — added `getOwnerHandles()` and `buildOwnerClause()` to `config.ts`; added `resolveOwnerHandles()` to `mcp.ts`; owner clause injected into all AI system prompts; owner nodes tagged `you (handle)` in `renderPacketForPrompt`
- 2026-06-07 — added `memory-export.ts` service; fixed `autonomy.ts` two-level tier resolution + streak reset; hardened `generateRoutineDigest` to never throw (returns graceful default)
- 2026-06-15 — `routines.ts` + `claude.ts`: rewrote `generateRoutineDigest` to use a free-form `{ summary, body }` digest instead of the rigid `{ summary, items, proposed_actions }` JSON schema; the prompt now instructs the model to fully carry out the routine's analysis and format a markdown body following the prompt's requested grouping; response parsing is line-delimited (`SUMMARY:` prefix line + markdown body) so rich grouped output is never discarded; `runClaude` gains an optional `timeoutMs` param (digest uses 240 s); on failure, logs with `console.error('[claude] routine digest failed:')` and returns an honest "Could not generate digest" message instead of the silent `<name> completed` placeholder. `RoutineCard.tsx` `parseDigest` type updated to `{ summary, body }`; redundant `items` bullet block removed (body in the chat thread covers it).
- 2026-06-10 — `embeddings.ts`: migrated from deprecated `@xenova/transformers` (v2) to `@huggingface/transformers` (v3, transformers.js successor); `quantized: true` option replaced with `dtype: 'q8'` (v3 API); clears the critical `protobufjs` CVE (GHSA-xq3m-2v4x-88gg and 7 others) pulled in via the old onnxruntime-web transitive dep. Build toolchain upgraded: vite 5→7, electron-vite 2→5, @vitejs/plugin-react 4→5, electron-builder 25→26, @electron/rebuild 3→4, uuid 10→11 (plus overrides). Electron stays at 33.x (better-sqlite3 v8 API incompatible with electron 39.8.5+ — known upstream issue; CVE debt tracked separately).
- 2026-06-06 — initial documentation; reflects services as of commit d8a8774
