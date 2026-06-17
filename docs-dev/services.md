# Main Process Services

All services live in `src/main/services/`. They run in the Node.js main process and are called from `src/main/ipc-handlers.ts` or from each other.

---

## `claude.ts` — Claude CLI integration

Spawns the `claude` CLI for all AI work. See [claude-integration.md](claude-integration.md) for the detailed write-up.

**Key exports:**

| Export | Description |
|---|---|
| `detectClaudeBin()` | Non-throwing resolver: returns the absolute path to the `claude` CLI or `null`; used by the runtime and by `setup:check-prerequisites` / `setup:get-health` so both code paths use identical detection logic |
| `runClaude(systemPrompt, userPrompt, source?, timeoutMs?)` | One-shot JSON completion (default 120 s timeout, overridable); records usage |
| `runClaudeWithMcp(systemPrompt, userPrompt, source?)` | One-shot with live MCP access; writes a temp `--mcp-config` file from connected servers, passes a read-only `--allowedTools` allowlist (tools whose names start with `get`/`list`/`search`/`read`/`fetch`/`view`/`find`/`show`/`describe`/`query`/`lookup`/`check`), then falls back to `runClaude` if no servers are connected |
| `streamChat(history, userMessage, onChunk, onDone, rawContext?, streamId?, source?)` | Streaming multi-turn chat; records usage on completion |
| `cancelStream(streamId)` | Kill an active stream by ID; returns `true` if found |
| `generatePlanDraft(intent)` | Parse free-text intent → `PlanDraft` |
| `generateRoutineDigest(name, promptTemplate, rawOutput)` | Summarize MCP output → `RoutineDigest` (`{ summary, body }`) |
| `generateRoutineSetup(intent, servers)` | Natural-language intent → validated `RoutineSetupDraft` |

---

## `usage.ts` — Usage recorder

Thin wrapper around `dbInsertUsage` so `claude.ts` doesn't import the DB layer directly. All errors are swallowed — telemetry never breaks an AI call.

**Key exports:**

| Export | Description |
|---|---|
| `recordUsage(source, model, cliResult)` | Persist a `usage_events` row from a CLI result object |

---

## `mcp.ts` — MCP client manager

Manages stdio MCP server connections using `@modelcontextprotocol/sdk`. See [mcp-and-oauth.md](mcp-and-oauth.md) for details.

**Key exports:**

| Export | Description |
|---|---|
| `connectServer(cfg)` | Connect a single MCP server and cache it |
| `disconnectServer(name)` | Gracefully disconnect and remove from cache |
| `connectAllServers()` | Connect all enabled servers from config; serialized via mutex |
| `reconnectServer(name)` | Test or restore a named server under the mutex; returns `McpServerStatus`. Non-destructive when already connected: probes the live client with `listTools`; only falls back to a full reconnect if the probe fails or the server was not in the Map. Used by Settings "Test connection". |
| `disconnectAllServers()` | Disconnect all active connections |
| `callTool(server, tool, params)` | Call a tool on a connected server |
| `getServerStatus()` | Return `McpServerStatus[]` from the in-memory Map (no reconnect) |

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
| `executeRoutine(routine, widgetWin)` | Run all MCP actions, call `generateRoutineDigest`, run `inferRoutineIntents` over the raw output, route each result through `routeIntent`, fire OS notification, push events to renderer |
| `handleRunMessage(runId, userMsg)` | Streaming follow-up chat on a run thread; broadcasts `routine:user-message` before streaming |
| `dismissRun(runId, status)` | Mark a run as resolved/dismissed |

**Execution steps (Phase B):**
1. Execute all MCP actions → collect `rawOutput`
2. `generateRoutineDigest` → persist `{ summary, body }` digest + chat message (renders the full markdown body); on failure logs the error and stores an honest "could not generate" message
3. `inferRoutineIntents(name, rawOutput)` → up to 3 `IntentObject`s
4. `routeIntent(obj, 'routine', ...)` for each — tier resolution, DB persist, graph node, notify
5. OS notification (digest `summary`) + push events to both windows

---

## `plan.ts` — Plan item lifecycle

**Key exports:**

| Export | Description |
|---|---|
| `createPlanDraft(intent)` | Delegates to `generatePlanDraft` in `claude.ts` |
| `confirmPlanDraft(draft)` | Persists the draft as a `PlanItem`, mirrors it into the graph as a `plan_item` node with `targets` edges to referenced entities |
| `updatePlanItemStatus(id, status)` | Update status; appends to `plan_item_history` |
| `deletePlanItem(id)` | Delete item and cascade |
| `handlePlanMessage(itemId, userMsg)` | Streaming chat on a plan-item thread; broadcasts `plan:user-message` before streaming |

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

**Key exports (non-IPC):**

| Export | Description |
|---|---|
| `routeIntent(obj, triggerKind, contextPacket, focusNodeIds, win)` | Route an already-inferred `IntentObject` through the full tier/DB/graph/notify pipeline. Used by `routines.ts` to feed routine-generated action candidates into the same queue as ambient intents. |
| `ambientSuggestIntent(id, userMessage)` | Multi-round re-proposal: persists user message → calls `reproposeIntent` (with live read-only MCP access) → persists assistant reply → updates proposal fields via `dbReproposeIntent` → broadcasts `ambient:intent-updated` and `ambient:intent-message`. Returns `{intent, assistantMessage}` or null on error. |
| `ambientGetIntentThread(id)` | Returns the `ChatMessage[]` thread for an intent from `intent_threads`. |
| `revalidatePendingIntents()` (internal) | Freshness revalidation: for each pending intent, maps work-item focus nodes to their `signals` rows, checks whether the surface has completed a successful non-truncated poll after the intent was created, and whether the signal was absent from that poll. Requires 2 consecutive misses (tracked in `intentMissCount`) before expiring the intent. Broadcasts `ambient:intent-updated` with `status: 'expired'` and refreshes the tray. Surface-agnostic — works for any adapter. |

---

## `autonomy.ts` — Trust tier engine

Manages the `autonomy_policy` table and the promotion/demotion of action-type tiers. Handles approve/challenge/dismiss outcomes and updates consecutive-approval streaks used for automatic tier promotion.

**Two-level tier resolution:** `resolveTier(obj)` looks up the earned per-`surface:verb` policy first, then falls back to the intent-type-level policy (what the user set in Settings for e.g. all "action" intents), then to the hardcoded default (tier 2). This means user Settings choices are live defaults that earned trust can refine on top of.

---

## `triggers.ts` — Trigger evaluators

One evaluator per `TriggerKind` (`waiting`, `spike`, `staleness`, `dependency`, `time`). Each evaluator queries the graph/signals DB and returns candidate `TriggerHit`s passed to `inference.ts`.

The `waiting` (structural) trigger replaces the old regex-driven `directed` trigger. `evalWaitingOnMe(newSignals)` fires on inbound signals where `directed=1` (assigned, review-requested, mentioned, or DM/thread-replied); `evalWaitingOnMeFromGraph()` is the heartbeat variant that queries `dbGetDirectedSignals` from persisted data. The `staleness` trigger (now called `evalStaleAndMine`) is restricted to owner-assigned or review-requested nodes. The `directed` TriggerKind and `evaluationCount % 6` gate were removed in the 2026-06-11 "Needs me" reframe. `evalThreshold` and the `evalStaleness` alias were removed (dead code — neither was imported in any call path).

---

## `ingestion.ts` — Signal ingestion pipeline

Coordinates the flow from raw API payloads to structured `Signal` rows and graph entries. Deduplicates by `(surface, external_id)`. Calls `ingestSignalIntoGraph` from `memory-graph.ts`.

`SurfaceAdapter.poll()` now returns `{ observations: RawObservation[]; complete: boolean }`. `complete` must be `true` only when no query hit its page/count limit (GitHub `per_page` raised to 50). `runAdapterPoll` records `lastCompletePollAt` per surface when `complete=true` and no error occurred. `getLastCompletePollAt(surface)` is exported for use by `revalidatePendingIntents()` in `ambient.ts`.

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
| `kindToNodeType(kind)` | Map a signal kind string to a `NodeType` |
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
| `startCheckIn(trigger, win)` | Create a new session (or return existing active one), stream opening briefing |
| `handleCheckInMessage(checkinId, userMessage, win)` | Send a user message, stream response |
| `endCheckIn(checkinId)` | Mark as extracting, run knowledge extraction async, update status |
| `cancelCheckinStream(checkinId)` | Cancel an active stream by session ID |

**Knowledge extraction:** After `endCheckIn`, a non-streaming Claude pass reads the full thread and returns JSON with `memories[]`, `weight_adjustments[]`, and `new_edges[]`. Each is validated and applied to the DB via existing graph/memory functions.

**Config:** `AppConfig.checkin.scheduleEnabled` + `AppConfig.checkin.schedule` (cron). Scheduling is wired through `cron.ts` (`refreshCheckinSchedule`).

## Changelog

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
