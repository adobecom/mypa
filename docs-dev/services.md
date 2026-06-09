# Main Process Services

All services live in `src/main/services/`. They run in the Node.js main process and are called from `src/main/ipc-handlers.ts` or from each other.

---

## `claude.ts` — Claude CLI integration

Spawns the `claude` CLI for all AI work. See [claude-integration.md](claude-integration.md) for the detailed write-up.

**Key exports:**

| Export | Description |
|---|---|
| `runClaude(systemPrompt, userPrompt, source?)` | One-shot JSON completion (120 s timeout); records usage |
| `streamChat(history, userMessage, onChunk, onDone, rawContext?, streamId?, source?)` | Streaming multi-turn chat; records usage on completion |
| `cancelStream(streamId)` | Kill an active stream by ID; returns `true` if found |
| `generatePlanDraft(intent)` | Parse free-text intent → `PlanDraft` |
| `generateRoutineDigest(name, promptTemplate, rawOutput)` | Summarize MCP output → `RoutineDigest` |
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
| `connectAllServers()` | Connect all enabled servers from config |
| `disconnectAllServers()` | Disconnect all active connections |
| `callTool(server, tool, params)` | Call a tool on a connected server |
| `getServerStatus()` | Return `McpServerStatus[]` for all configured servers |
| `testServer(cfg)` | Connect, list tools, disconnect — used by settings UI |

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
2. `generateRoutineDigest` → persist digest + chat message
3. `inferRoutineIntents(name, rawOutput)` → up to 3 `IntentObject`s
4. `routeIntent(obj, 'routine', ...)` for each — tier resolution, DB persist, graph node, notify
5. OS notification (digest summary) + push events to both windows

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

---

## `autonomy.ts` — Trust tier engine

Manages the `autonomy_policy` table and the promotion/demotion of action-type tiers. Handles approve/challenge/dismiss outcomes and updates consecutive-approval streaks used for automatic tier promotion.

**Two-level tier resolution:** `resolveTier(obj)` looks up the earned per-`surface:verb` policy first, then falls back to the intent-type-level policy (what the user set in Settings for e.g. all "action" intents), then to the hardcoded default (tier 2). This means user Settings choices are live defaults that earned trust can refine on top of.

---

## `triggers.ts` — Trigger evaluators

One evaluator per `TriggerKind` (`spike`, `staleness`, `dependency`, `threshold`, `time`, `directed`). Each evaluator queries the graph/signals DB and returns candidate `TriggerHit`s passed to `inference.ts`.

The `directed` trigger fires on a single inbound signal from a non-owner actor whose `title`/`body` matches a set of request/question patterns (`?`, `can we`, `please`, `lgtm`, `review`, etc.). It reads owner handles from `readConfig()` to distinguish the user's own activity from teammates' requests. At most one hit per poll cycle to avoid flooding inference.

---

## `ingestion.ts` — Signal ingestion pipeline

Coordinates the flow from raw API payloads to structured `Signal` rows and graph entries. Deduplicates by `(surface, external_id)`. Calls `ingestSignalIntoGraph` from `memory-graph.ts`.

---

## `inference.ts` — Intent generation

Takes a `ContextPacket` (assembled by `memory-graph.ts`) and produces scored `Intent` candidates that are persisted to the `intents` table and surfaced in the renderer.

**Key exports:**

| Export | Description |
|---|---|
| `inferIntent(hit, packet?)` | Single-intent inference from a `TriggerHit`; returns one `IntentObject` or null |
| `inferRoutineIntents(name, rawOutput, maxIntents?)` | Multi-intent inference over routine MCP output; returns up to `maxIntents` (default 3) `IntentObject`s as a JSON array parsed from one Claude call |
| `parseIntentObject(text)` | Parse + validate a raw JSON string into an `IntentObject`; clamps unknown verbs to `'none'` |

---

## `embeddings.ts` — Local embeddings

Generates text embeddings using [`@xenova/transformers`](https://github.com/xenova/transformers.js) entirely on-device (no network call). Used by `memory-graph.ts` to build semantic similarity edges.

**Key exports:**

| Export | Description |
|---|---|
| `embedText(text)` | Returns a Float32Array embedding vector |
| `cosineSim(a, b)` | Cosine similarity between two Float32Arrays |
| `blobToFloat(blob)` | Deserialize a BLOB column value to Float32Array |

---

## `memories.ts` — Memory CRUD

Typed wrappers around the DB query functions for the `memories` table. Provides `createMemory`, `getActiveMemories`, `getMemoriesForNode`, `supersedeMemory`, `updateMemory`.

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

- 2026-06-09 — `plan.ts`, `routines.ts`: removed `widgetWin` param from `handlePlanMessage` and `handleRunMessage`; both now broadcast `plan:user-message` / `routine:user-message` (with the saved `ChatMessage`) immediately after the DB write, before streaming; `badge:updated` changed from widget-only send to `broadcast()` in both services
- 2026-06-09 — `config.ts`: added `encryptClaude` / `decryptClaude` helpers (mirror the OAuth single-field pattern); chained into `readConfig` and `writeConfig`; added `clearClaudeApiKey()` export (explicit delete, since `deepMerge` skips `undefined`); `AppConfig.claude.apiKey` is now encrypted at rest via `safeStorage`
- 2026-06-08 — added `checkin.ts`; new exports `startCheckIn`, `handleCheckInMessage`, `endCheckIn`, `cancelCheckinStream`; `cron.ts` gains `refreshCheckinSchedule` (module-level scheduled task for periodic check-ins); `config:update` IPC handler now calls `refreshCheckinSchedule` when `checkin.*` config fields change
- 2026-06-08 — `triggers.ts`: added `directed` trigger kind; `evalDirectedAtMe` fires on single inbound signals from non-owner actors that contain question/request language; wired into `evalEventTriggers` alongside spike and dependency
- 2026-06-07 — added `updater.ts`; wraps `electron-updater` for GitHub Releases auto-update; adds `checkForUpdatesNow` and `installUpdate` exports; pushes `update:available`, `update:progress`, `update:downloaded`, `update:error` channels to all windows
- 2026-06-07 — new `usage.ts` recorder; `claude.ts` switched `runClaude` to `--output-format json` and added `source: UsageSource` param; both `runClaude` and `runClaudeStream` call `recordUsage()` after each Claude call; `streamChat` and all callers (`routines.ts`, `plan.ts`, `inference.ts`, `memories.ts`) updated with source labels
- 2026-06-07 — `routines.ts`: `routine:run-started` and `routine:run-completed` now sent via `broadcast()` (both widget + main windows) instead of widget-only `webContents.send`; `ambient.ts`: emits new `ambient:action-executed` broadcast after a tier-0 intent auto-executes successfully; added `broadcast()` helper to `windows.ts`
- 2026-06-07 — added `getOwnerHandles()` and `buildOwnerClause()` to `config.ts`; added `resolveOwnerHandles()` to `mcp.ts`; owner clause injected into all AI system prompts; owner nodes tagged `you (handle)` in `renderPacketForPrompt`
- 2026-06-07 — added `memory-export.ts` service; fixed `autonomy.ts` two-level tier resolution + streak reset; hardened `generateRoutineDigest` to never throw (returns graceful default)
- 2026-06-06 — initial documentation; reflects services as of commit d8a8774
