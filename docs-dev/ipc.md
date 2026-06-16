# IPC Reference

**Source of truth:** `src/shared/types.ts` — the `IpcApi` interface.

All renderer ↔ main communication flows through `window.electron` (typed as `IpcApi`), injected by `src/preload/index.ts` via Electron's `contextBridge`.

## How to add a channel

1. Add the method signature to `IpcApi` in `src/shared/types.ts`.
2. Implement it with `ipcMain.handle('namespace:method', handler)` in `src/main/ipc-handlers.ts`.
3. Expose it in `src/preload/index.ts` under the appropriate namespace object.

---

## Namespaces

### `plan`

Manage plan items and their chat threads.

| Method | Signature | Description |
|---|---|---|
| `createDraft` | `(intent: string) → PlanDraft` | Ask Claude to parse a free-text intent into a structured draft |
| `confirm` | `(draft: PlanDraft) → PlanItem` | Persist a draft as a plan item (and mirror it into the knowledge graph) |
| `getAll` | `() → PlanItem[]` | Fetch all plan items |
| `getItem` | `(itemId) → PlanItem \| null` | Fetch a single plan item by ID |
| `updateStatus` | `(id, status: PlanItemStatus) → void` | Update status: `pending \| in_progress \| done \| skipped` |
| `delete` | `(id) → void` | Delete a plan item and its thread |
| `sendMessage` | `(itemId, message) → void` | Send a user chat message on a plan-item thread (streaming) |
| `getThread` | `(itemId) → ChatMessage[]` | Fetch the chat history for a plan item |
| `cancelStream` | `(itemId) → void` | Cancel an active streaming response |
| `openInMainWindow` | `(itemId) → void` | Open main window and navigate to the plan item's full chat view |

### `routines`

Manage scheduled routines, their runs, and run chat threads.

| Method | Signature | Description |
|---|---|---|
| `getAll` | `() → Routine[]` | Fetch all routines |
| `create` | `(data: RoutineInput) → Routine` | Create a new routine |
| `update` | `(id, data: Partial<RoutineInput>) → Routine` | Update a routine (reschedules cron automatically) |
| `delete` | `(id) → void` | Delete a routine and its runs |
| `runNow` | `(id) → void` | Trigger an immediate out-of-schedule run |
| `getRuns` | `(routineId, limit?) → RoutineRun[]` | Recent runs for a specific routine |
| `getAllRuns` | `(limit?) → RoutineRun[]` | All runs across all routines |
| `getThread` | `(runId) → ChatMessage[]` | Chat history for a specific run |
| `sendMessage` | `(runId, message) → void` | Chat follow-up on a run (streaming) |
| `updateRunStatus` | `(runId, status: RunStatus) → void` | Manually update a run's status |
| `generateSetup` | `(intent: string) → RoutineSetupDraft` | Ask Claude to create a routine config from a natural-language intent |
| `cancelStream` | `(runId) → void` | Cancel an active streaming response |
| `openRunInMainWindow` | `(runId) → void` | Open main window, navigate to Run Logs, and expand the target run in conversation view |

### `config`

Read and write app configuration; query MCP server status.

| Method | Signature | Description |
|---|---|---|
| `get` | `() → AppConfig` | Read the full config; `claude.apiKey` is stripped — use `getClaudeKey` for key status |
| `update` | `(config: Partial<AppConfig>) → void` | Deep-merge a partial config update |
| `testMcpServer` | `(cfg: McpServerConfig) → { ok, tools, error? }` | Test a single MCP server connection |
| `getMcpStatus` | `() → McpServerStatus[]` | Live connection status + tool list for all configured servers |
| `getClaudeKey` | `() → { configured: boolean; preview: string \| null }` | Returns whether a custom Anthropic API key is stored and a masked preview (e.g. `sk-ant-…AB12`); never returns the raw key |
| `setClaudeKey` | `(key: string \| null) → void` | Store or remove the custom API key (encrypted at rest); pass `null` or empty string to clear |

### `oauth`

OAuth flows for GitHub, Notion, and Linear.

| Method | Signature | Description |
|---|---|---|
| `startDevice` | `() → DeviceFlowStart` | Begin GitHub device flow; returns `userCode`, `verificationUri`, `deviceCode`, `interval` |
| `pollDevice` | `(deviceCode) → string` | Poll GitHub until token is issued; returns the access token |
| `startPkce` | `(provider: 'notion' \| 'linear') → string` | Begin PKCE flow; returns the authorization URL to open in browser |

The redirect URI for PKCE is `mypa://oauth/callback`. The `state` nonce is validated in `oauth.ts` to prevent authorization code injection.

### `setup`

Pre-flight checks and server auto-detection.

| Method | Signature | Description |
|---|---|---|
| `checkPrerequisites` | `() → { claudeCli: boolean }` | Check whether the `claude` CLI binary is on `$PATH` |
| `getHealth` | `() → SetupHealth` | Full health check: Claude CLI + each MCP server (missing env keys, invalid path args, OAuth staleness). `SetupHealthServer.invalidArgs?: string[]` carries path validation messages for servers with `isPath` argInputs. |
| `detectClaudeMcp` | `() → DetectedMcpServer[]` | Auto-detect MCP servers from an existing Claude Code config file |
| `resolveOwnerHandles` | `() → ResolvedOwnerHandles` | Best-effort: call each connected MCP server's identity tool and return per-surface handles with a `needsReview` flag for opaque IDs (e.g. Slack UIDs). Returns only surfaces where a handle was found. |

### `system`

OS-level and window utilities.

| Method | Signature | Description |
|---|---|---|
| `openMainWindow` | `(routineId?) → void` | Open (or focus) the main window; optionally navigate to a specific routine |
| `getBadgeCount` | `() → number` | Current unread badge count |
| `getWindowType` | `() → 'widget' \| 'main-window'` | Which window is calling — useful for shared components |
| `openExternal` | `(url: string) → void` | Open a URL in the OS default browser via `shell.openExternal` |
| `factoryReset` | `() → void` | Wipe `~/.mypa/config.json` and `~/.mypa/data.db`, then relaunch the app into onboarding |
| `pickDirectory` | `(multiple?) → string[]` | Open the native OS directory-picker dialog; returns an array of absolute paths or `[]` if cancelled. Pass `multiple: true` to allow multi-selection. Used by `ServerCatalogPicker` for `isPath`-type argInputs. |

### `ambient`

Ambient intelligence — intents, digests, policy, tray state.

| Method | Signature | Description |
|---|---|---|
| `getIntents` | `() → Intent[]` | Fetch all pending/surfaced intents |
| `getAllIntents` | `(limit?) → Intent[]` | Fetch all intents including terminal/historical ones (used by main-window Activity page) |
| `approve` | `(id, payload?) → Intent` | Approve an intent, optionally passing a user-edited payload (for draft-and-confirm). Persists the edited payload before executing. |
| `dismiss` | `(id) → void` | Dismiss an intent |
| `challenge` | `(id, reason) → Intent` | Challenge an intent with a reason; adjusts trust policy |
| `suggest` | `(id, message) → { intent: Intent; assistantMessage: string } \| null` | Multi-round Suggest: send user feedback, receive a re-proposed intent and a conversational reply. Intent stays non-terminal; can be called repeatedly. |
| `getIntentThread` | `(id) → ChatMessage[]` | Fetch the Suggest conversation thread for an intent. |
| `getDigest` | `(slot?) → AmbientDigest` | Fetch the latest digest for a slot (`morning \| midday \| eod`) |
| `getTrayState` | `() → TrayState` | Current tray state: `idle \| has-something \| needs-you` (driven only by `action`-type intents) |
| `getPolicy` | `() → AutonomyPolicy[]` | All per-action-type trust policies |
| `setTier` | `(actionType, tier, locked?) → void` | Manually set (and optionally lock) the trust tier for an action type |
| `resetTrust` | `() → void` | Reset all autonomy policies to defaults |
| `pollNow` | `() → void` | Trigger an immediate ambient poll cycle |
| `getLog` | `(limit?) → ActionLogEntry[]` | Recent autonomy event log |

### `memory`

Knowledge graph — nodes, edges, memories.

| Method | Signature | Description |
|---|---|---|
| `getGraph` | `() → { nodes: GraphNode[], edges: GraphEdge[] }` | Full graph snapshot for rendering |
| `getNode` | `(id) → { node, edges, memories, timeline } \| null` | Detail for a single node including its memories and signal timeline |
| `deleteNode` | `(id) → void` | Delete a node and its cascade edges/memories |
| `deleteEdge` | `(id) → void` | Delete a single edge |
| `deleteMemory` | `(id) → void` | Delete a memory entry |
| `updateMemory` | `(id, { content?, importance?, status? }) → void` | Edit or supersede a memory |
| `exportMarkdown` | `() → { saved: boolean; path?: string }` | Show a system save-file dialog and write a self-contained Markdown export of all memories + knowledge graph to the chosen path; `saved: false` when the dialog is cancelled |

---

## Push events (main → renderer)

Subscribed with `window.electron.on(channel, listener)`. Returns an unsubscribe function.

| Channel | Payload | When fired | Windows |
|---|---|---|---|
| `routine:run-started` | `RoutineRun` | A routine begins executing | **widget + main** |
| `routine:run-completed` | `RoutineRun` | A routine run finishes (success or error — inspect `run.status`) | **widget + main** |
| `routine:run-message` | `{ runId, chunk: string, done: boolean, error?: string }` | Streaming chat chunk on a run thread | **widget + main** |
| `routine:user-message` | `{ runId, message: ChatMessage }` | User message saved to a run thread (fires before streaming begins) | **widget + main** |
| `plan:item-message` | `{ itemId, chunk: string, done: boolean, error?: string }` | Streaming chat chunk on a plan-item thread | **widget + main** |
| `plan:user-message` | `{ itemId, message: ChatMessage }` | User message saved to a plan-item thread (fires before streaming begins) | **widget + main** |
| `plan:item-updated` | `{ id: string, status: PlanItemStatus }` | Plan item status changed (e.g. done/skipped from widget) | **widget + main** |
| `badge:updated` | `number` | Badge count changed | **widget + main** |
| `navigate:edit-routine` | `routineId: string` | Main window should navigate to the routine editor | main only |
| `navigate:run-chat` | `runId: string` | Main window should navigate to Run Logs and open that run in conversation view | main only |
| `navigate:plan-item` | `itemId: string` | Main window should navigate to the plan item's full chat detail page | main only |
| `ambient:intent-created` | `Intent` | A new intent was generated | widget only |
| `ambient:intent-updated` | `Intent` | An existing intent changed status | widget only |
| `ambient:tray-state` | `TrayState` | Tray icon state changed | widget only |
| `ambient:digest-ready` | `AmbientDigest` | A new digest was generated | widget only |
| `ambient:action-executed` | `Intent` | A tier-0 intent was auto-executed (success only) | **widget + main** |
| `ambient:intent-message` | `{ intentId: string; message: string }` | Assistant reply after a Suggest round (non-streaming; fires once when re-proposal completes) | **widget + main** |

**`routine:run-started` and `routine:run-completed` are broadcast to both windows** via `broadcast()` in `src/main/windows.ts`. The main window uses them to drive in-app toast notifications. The widget uses them to update its inline run card. All other events remain window-specific.

---

### `usage`

Token usage and estimated cost dashboard data. All data is recorded from the moment mypa was installed (no historical backfill).

| Method | Signature | Description |
|---|---|---|
| `getSummary` | `(range: UsageRange) → UsageSummary` | Headline totals: total tokens, cost, call count |
| `getDaily` | `(range: UsageRange) → UsageDailyPoint[]` | Per-day aggregates for the bar chart |
| `getBySource` | `(range: UsageRange) → UsageBreakdownRow[]` | Breakdown by feature (`UsageSource`) |
| `getByModel` | `(range: UsageRange) → UsageBreakdownRow[]` | Breakdown by model id |
| `getRecent` | `(limit: number) → UsageEvent[]` | Most recent N individual calls |

`UsageRange = '7d' | '30d' | '90d' | 'all'`

IPC channels: `usage:get-summary`, `usage:get-daily`, `usage:get-by-source`, `usage:get-by-model`, `usage:get-recent`.

---

### `update`

Trigger and install app updates delivered via GitHub Releases. Only meaningful in packaged builds — in dev mode all calls are no-ops.

| Method | Signature | Description |
|---|---|---|
| `checkNow` | `() → void` | Manually trigger an update check |
| `install` | `() → void` | Quit and install the downloaded update |

IPC channels: `update:check-now`, `update:install`.

Push channels (main → renderer):

| Channel | Payload | Description |
|---|---|---|
| `update:available` | `{ version: string, releaseNotes: any }` | A newer version was found and is downloading |
| `update:progress` | `{ percent: number }` | Download progress (0–100) |
| `update:downloaded` | — | Download complete; ready to install |
| `update:error` | `message: string` | Update check or download failed |
| `checkin:started` | `CheckIn` | A new check-in session has been created |
| `checkin:message` | `{ checkinId, chunk, done, error? }` | Streaming token from briefing or chat response |
| `checkin:status-changed` | `CheckIn` | Session status changed (extracting → complete / error) |
| `navigate:checkin` | `string \| null` | Open main window on the Check-in page and expand the given session |

## Key types (abbreviated)

Full definitions in `src/shared/types.ts`.

```ts
type PlanItemStatus  = 'pending' | 'in_progress' | 'done' | 'skipped'
type PlanItemTiming  = 'now' | 'morning' | 'afternoon' | 'evening' | 'anytime'
type RunStatus       = 'running' | 'pending_response' | 'in_progress'
                     | 'resolved' | 'dismissed' | 'error'
type IntentType      = 'action' | 'suggestion' | 'flag' | 'digest'
type IntentStatus    = 'pending' | 'surfaced' | 'approved' | 'executed'
                     | 'challenged' | 'dismissed' | 'expired' | 'failed'
type Tier            = 0 | 1 | 2 | 3   // 0 = fully automatic, 3 = always approve
type TrayState       = 'idle' | 'has-something' | 'needs-you'
type DigestSlot      = 'morning' | 'midday' | 'eod'
type MemoryType      = 'fact' | 'pattern' | 'preference' | 'status'
```

### `checkin`

Manage PA check-in sessions and their chat threads.

| Method | Signature | Description |
|---|---|---|
| `start` | `() → CheckIn` | Start a new check-in (returns existing active session if one is in progress) |
| `getActive` | `() → CheckIn \| null` | Get the current active session, if any |
| `getAll` | `(limit?) → CheckIn[]` | List all sessions, newest first |
| `getThread` | `(checkinId) → ChatMessage[]` | Fetch full message thread for a session |
| `sendMessage` | `(checkinId, message) → void` | Send a user message (streaming) |
| `end` | `(checkinId) → void` | End the session and trigger async knowledge extraction |
| `cancelStream` | `(checkinId) → void` | Cancel active streaming response |
| `openInMainWindow` | `(checkinId?) → void` | Open main window on Check-in page, expanding the given session |

## Changelog

- 2026-06-09 — action-centric ambient redesign (Phase A): `ambient.approve` gains optional `payload?` arg for draft-and-confirm; `ambient.getAllIntents(limit?)` added for historical queries; `ambient:approve`/`dismiss`/`challenge` IPC handlers now broadcast updates to both windows (was widget-only); tray state and badge now driven only by `type:"action"` intents — informational (flag/digest/suggestion) no longer notify or light up the tray
- 2026-06-09 — added `plan:user-message` and `routine:user-message` push channels (broadcast to both windows immediately after user message is saved to DB, before streaming begins); changed `badge:updated` to broadcast to both windows (was widget-only); removed unused `widgetWin` parameter from `handlePlanMessage` and `handleRunMessage` services
- 2026-06-09 — added `config.getClaudeKey` and `config.setClaudeKey` channels; `config.get` now strips `claude.apiKey` before returning to the renderer (raw key never transmitted); `ClaudeConfig` gained `apiKey?: string` (encrypted at rest via `safeStorage`)
- 2026-06-10 — `CheckInExtractionSummary` gains `scopeUpdated: number` (count of scope identifiers auto-derived from the check-in transcript and unioned into `AppConfig.scope.allowed`). `ScopeConfig` reshaped to `{ allowed?: Record<string, string[]> }` — surface-keyed map replacing the three named fields (`allowedGithubOrgs` etc.); backward-compat read shim in `scope.ts`. The Scope card in Settings is now read-only.
- 2026-06-08 — added `checkin` namespace (`start`, `getActive`, `getAll`, `getThread`, `sendMessage`, `end`, `cancelStream`, `openInMainWindow`); new push channels `checkin:started`, `checkin:message`, `checkin:status-changed`, `navigate:checkin`; added `CheckInStatus`, `CheckIn`, `CheckInConfig`, `CheckInExtractionSummary` types; `AppConfig.checkin?: CheckInConfig`; `UsageSource` extended with `'checkin_chat'` and `'checkin_extract'`
- 2026-06-16 — added `system.pickDirectory(multiple?)` IPC channel (`system:pick-directory`; uses `dialog.showOpenDialog` with `openDirectory`/`createDirectory`/`multiSelections` properties); `SetupHealthServer` gains `invalidArgs?: string[]` (path-type arg validation; populated by updated `setup:get-health` handler)
- 2026-06-10 — added `system.factoryReset` channel; wipes config.json + data.db then relaunches via `app.relaunch()+app.exit(0)`; surfaced in Settings → Danger Zone card
- 2026-06-08 — added `system.openExternal` method + `system:open-external` IPC handler (opens URL in default browser via `shell.openExternal`); added `plan:item-updated` push channel (broadcast to both windows when plan item status changes); both windows now have `will-navigate` + `setWindowOpenHandler` guards that redirect external URLs to the default browser
- 2026-06-08 — added `plan.getItem`, `plan.openInMainWindow`; `routines.openRunInMainWindow`; new push channels `navigate:run-chat` and `navigate:plan-item`; `Intent` type gained `challenge_reason: string | null`
- 2026-06-07 — added `update` namespace (`checkNow`, `install`); new push channels `update:available`, `update:progress`, `update:downloaded`, `update:error`
- 2026-06-07 — added `usage` namespace (`getSummary`, `getDaily`, `getBySource`, `getByModel`, `getRecent`); new types `UsageSource`, `UsageEvent`, `UsageSummary`, `UsageDailyPoint`, `UsageBreakdownRow`, `UsageRange` in `@shared/types`
- 2026-06-07 — added `ambient:action-executed` push channel (broadcast to both windows on tier-0 auto-execution); `routine:run-started` and `routine:run-completed` are now broadcast to both windows via `broadcast()` in `src/main/windows.ts` (previously widget-only)
- 2026-06-07 — added `setup.resolveOwnerHandles` channel; added `AppConfig.owner` (`OwnerIdentity`) type; added `ResolvedOwnerHandles` / `ResolvedHandle` types to `@shared/types`
- 2026-06-07 — added `memory.exportMarkdown` channel; IPC handler drives `dialog.showSaveDialog` + `fs.writeFileSync`
- 2026-06-06 — initial documentation; reflects `IpcApi` as of commit d8a8774
