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
| `updateStatus` | `(id, status: PlanItemStatus) → void` | Update status: `pending \| in_progress \| done \| skipped` |
| `delete` | `(id) → void` | Delete a plan item and its thread |
| `sendMessage` | `(itemId, message) → void` | Send a user chat message on a plan-item thread (streaming) |
| `getThread` | `(itemId) → ChatMessage[]` | Fetch the chat history for a plan item |
| `cancelStream` | `(itemId) → void` | Cancel an active streaming response |

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

### `config`

Read and write app configuration; query MCP server status.

| Method | Signature | Description |
|---|---|---|
| `get` | `() → AppConfig` | Read the full config (secrets are decrypted in memory, not transmitted raw) |
| `update` | `(config: Partial<AppConfig>) → void` | Deep-merge a partial config update |
| `testMcpServer` | `(cfg: McpServerConfig) → { ok, tools, error? }` | Test a single MCP server connection |
| `getMcpStatus` | `() → McpServerStatus[]` | Live connection status + tool list for all configured servers |

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
| `getHealth` | `() → SetupHealth` | Full health check: Claude CLI + each MCP server (missing env keys, OAuth staleness) |
| `detectClaudeMcp` | `() → DetectedMcpServer[]` | Auto-detect MCP servers from an existing Claude Code config file |
| `resolveOwnerHandles` | `() → ResolvedOwnerHandles` | Best-effort: call each connected MCP server's identity tool and return per-surface handles with a `needsReview` flag for opaque IDs (e.g. Slack UIDs). Returns only surfaces where a handle was found. |

### `system`

OS-level and window utilities.

| Method | Signature | Description |
|---|---|---|
| `openMainWindow` | `(routineId?) → void` | Open (or focus) the main window; optionally navigate to a specific routine |
| `getBadgeCount` | `() → number` | Current unread badge count |
| `getWindowType` | `() → 'widget' \| 'main-window'` | Which window is calling — useful for shared components |

### `ambient`

Ambient intelligence — intents, digests, policy, tray state.

| Method | Signature | Description |
|---|---|---|
| `getIntents` | `() → Intent[]` | Fetch all pending/surfaced intents |
| `approve` | `(id) → Intent` | Approve an intent (executes it if tier allows) |
| `dismiss` | `(id) → void` | Dismiss an intent |
| `challenge` | `(id, reason) → Intent` | Challenge an intent with a reason; adjusts trust policy |
| `getDigest` | `(slot?) → AmbientDigest` | Fetch the latest digest for a slot (`morning \| midday \| eod`) |
| `getTrayState` | `() → TrayState` | Current tray state: `idle \| has-something \| needs-you` |
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
| `routine:run-message` | `{ runId, chunk: string, done: boolean, error?: string }` | Streaming chat chunk on a run thread | widget only |
| `plan:item-message` | `{ itemId, chunk: string, done: boolean, error?: string }` | Streaming chat chunk on a plan-item thread | widget only |
| `badge:updated` | `number` | Badge count changed | widget only |
| `navigate:edit-routine` | `{ routineId: string }` | Main window should navigate to the routine editor | main only |
| `ambient:intent-created` | `Intent` | A new intent was generated | widget only |
| `ambient:intent-updated` | `Intent` | An existing intent changed status | widget only |
| `ambient:tray-state` | `TrayState` | Tray icon state changed | widget only |
| `ambient:digest-ready` | `AmbientDigest` | A new digest was generated | widget only |
| `ambient:action-executed` | `Intent` | A tier-0 intent was auto-executed (success only) | **widget + main** |

**`routine:run-started` and `routine:run-completed` are broadcast to both windows** via `broadcast()` in `src/main/windows.ts`. The main window uses them to drive in-app toast notifications. The widget uses them to update its inline run card. All other events remain window-specific.

---

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

## Changelog

- 2026-06-07 — added `ambient:action-executed` push channel (broadcast to both windows on tier-0 auto-execution); `routine:run-started` and `routine:run-completed` are now broadcast to both windows via `broadcast()` in `src/main/windows.ts` (previously widget-only)
- 2026-06-07 — added `setup.resolveOwnerHandles` channel; added `AppConfig.owner` (`OwnerIdentity`) type; added `ResolvedOwnerHandles` / `ResolvedHandle` types to `@shared/types`
- 2026-06-07 — added `memory.exportMarkdown` channel; IPC handler drives `dialog.showSaveDialog` + `fs.writeFileSync`
- 2026-06-06 — initial documentation; reflects `IpcApi` as of commit d8a8774
