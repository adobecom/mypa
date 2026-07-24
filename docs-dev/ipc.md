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
| `approveChatAction` | `(itemId, messageId, editedPayload?) → ProposedChatAction` | Approve and execute a pending write action proposed in a plan-item chat message |
| `dismissChatAction` | `(itemId, messageId) → ProposedChatAction` | Dismiss a pending write action in a plan-item chat message (no execution) |

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
| `update` | `(config: Partial<AppConfig>) → AppConfig` | Deep-merge a partial config update; returns the resulting merged config. The `claude.apiKey` field is silently stripped from the incoming partial — use `setClaudeKey` to change the API key. |
| `reconnectMcpServer` | `(name: string) → McpServerStatus` | Reconnect a single named server from config and return its live status (this IS the settings "Test connection" action — it updates the real connection Map so the UI dot reflects the true state) |
| `reconnectAll` | `() → McpServerStatus[]` | Re-connect all configured servers and return their live status; used by the Re-check button to actually re-probe rather than read stale cache |
| `getMcpStatus` | `() → McpServerStatus[]` | Read current live connection status + tool list from the in-memory Map (no reconnect) |
| `getClaudeKey` | `() → { configured: boolean; preview: string \| null }` | Returns whether a custom Anthropic API key is stored and a masked preview (e.g. `sk-ant-…AB12`); never returns the raw key |
| `setClaudeKey` | `(key: string \| null) → void` | Store or remove the custom API key (encrypted at rest); pass `null` or empty string to clear |

### `repos`

Links external repos/projects (GitHub `owner/repo`, Jira project keys) to a local git checkout, for code authoring. `RepoLink[]` is stored in `AppConfig.repos`, not the DB — see `repos.ts` and [code-authoring.md](code-authoring.md). Repos are auto-discovered by scanning user-chosen parent folders (`AppConfig.codeRoots`), not added by hand — see `getCodeRoots`/`addCodeRoots`/`removeCodeRoot`/`rescan` below.

| Method | Signature | Description |
|---|---|---|
| `getAll` | `() → RepoLink[]` | List all registered repo links (discovered + any legacy manual ones) |
| `update` | `(id, update: Partial<RepoLink>) → RepoLink` | Patch a repo link — used for the per-repo `authoringEnabled` toggle. `localPath`/`githubRepo`/`jiraProjectKeys` are scanner-owned (re-derived on every rescan) and not user-editable. |
| `getCodeRoots` | `() → string[]` | Parent folders mypa scans for local git checkouts |
| `addCodeRoots` | `(paths: string[]) → { roots: string[]; repos: RepoLink[] }` | Adds code roots and immediately rescans; returns the updated roots and repo list |
| `removeCodeRoot` | `(path: string) → { roots: string[]; repos: RepoLink[] }` | Removes a code root and immediately rescans |
| `rescan` | `() → RepoLink[]` | Re-scans all configured code roots on demand (Settings "Rescan" button) |

### `oauth`

OAuth/sign-in flows. PKCE for Notion and Linear; device-code sign-in for Outlook. GitHub is not an OAuth entry — it's a plain PAT/`api_key` catalog entry (see [mcp-and-oauth.md](mcp-and-oauth.md#github--personal-access-token)).

| Method | Signature | Description |
|---|---|---|
| `startPkce` | `(provider: 'notion' \| 'linear') → string` | Begin PKCE flow; returns the authorization URL to open in browser |
| `startDeviceLogin` | `(entryId: string, env: Record<string, string>) → void` | Run a catalog entry's own device-code login (currently `outlook`); resolves once sign-in completes. No token is returned — the MCP server manages its own token cache. See [mcp-and-oauth.md](mcp-and-oauth.md#outlook--device-code-flow) |

The redirect URI for PKCE is `mypa://oauth/callback`. The `state` nonce is validated in `oauth.ts` to prevent authorization code injection. The device-code user code and verification URL are delivered separately via the `oauth:device-code` push channel (below), not this method's return value.

### `setup`

Pre-flight checks and server auto-detection.

| Method | Signature | Description |
|---|---|---|
| `checkPrerequisites` | `() → { ok: boolean; source: AuthSource }` | Probe for active Claude credentials (priority: stored API key → env var → `~/.claude/.credentials.json`). `source` is one of `'apikey' \| 'env' \| 'cli-login' \| 'none'`. |
| `getHealth` | `() → SetupHealth` | Full health check: Claude auth + each MCP server (missing env keys, invalid path args, OAuth staleness). `SetupHealth.auth: { ok, source: AuthSource }` replaces the old `claudeCli: boolean`. `SetupHealthServer.invalidArgs?: string[]` carries path validation messages for servers with `isPath` argInputs. |
| `detectClaudeMcp` | `() → DetectedMcpServer[]` | Auto-detect MCP servers from an existing Claude Code config file |
| `resolveOwnerHandles` | `() → ResolvedOwnerHandles` | Best-effort: call each connected MCP server's identity tool and return per-surface handles with a `needsReview` flag for opaque IDs (e.g. Slack UIDs). Returns only surfaces where a handle was found. |

### `system`

OS-level and window utilities.

| Method | Signature | Description |
|---|---|---|
| `openMainWindow` | `(routineId?) → void` | Open (or focus) the main window; optionally navigate to a specific routine |
| `getBadgeCount` | `() → number` | Current unread badge count |
| `getWindowType` | `() → 'widget' \| 'main-window'` | Which window is calling — useful for shared components. Resolved in the preload from `window.location.pathname`; no main-process round-trip. |
| `openExternal` | `(url: string) → void` | Open a URL in the OS default browser via `shell.openExternal` |
| `factoryReset` | `() → void` | Wipe `~/.mypa/config.json` and `~/.mypa/data.db`, then relaunch the app into onboarding |
| `pickDirectory` | `(multiple?) → string[]` | Open the native OS directory-picker dialog; returns an array of absolute paths or `[]` if cancelled. Pass `multiple: true` to allow multi-selection. Used by `ServerCatalogPicker` for `isPath`-type argInputs. |

### `knowledge`

Local knowledge-vault (Obsidian) configuration support.

| Method | Signature | Description |
|---|---|---|
| `listVaultFolders` | `(path: string) → string[]` | Lists top-level subfolder names under an absolute path (used by the Settings vault-folder checkboxes). Returns `[]` if the path doesn't exist. |

Vault ingestion itself is configured via the generic `config.get`/`config.update` on `AppConfig.knowledge.vault` (`{ path, folders, enabled }`) — see [knowledge-graph.md](knowledge-graph.md) and [services.md](services.md).

### `ambient`

Ambient intelligence — intents, digests, policy, tray state.

| Method | Signature | Description |
|---|---|---|
| `getIntents` | `() → Intent[]` | Fetch all pending/surfaced intents |
| `getAllIntents` | `(limit?) → Intent[]` | Fetch all intents including terminal/historical ones (used by main-window Activity page) |
| `approve` | `(id, payload?) → Intent` | Approve an intent, optionally passing a user-edited payload (for draft-and-confirm). Persists the edited payload before executing. |
| `dismiss` | `(id) → void` | Dismiss an intent |
| `challenge` | `(id, reason) → Intent` | Challenge an intent with a reason; adjusts trust policy |
| `reviseFromChat` | `(id) → { intent: Intent; applied: boolean; message: string } \| null` | Revise the intent's proposal using the existing Chat thread. `applied` is `true` when the new proposal passed the confidence/urgency floors and was committed; `false` when below-floor (message-only). The assistant message is appended to the chat thread either way. |
| `sendChatMessage` | `(id, message) → void` | Send a user message in the streaming "Chat about it" thread for an intent. Streams response via `ambient:chat-message` push events. MCP read-only tools are available to Claude during the stream; write-action proposals appear as `<action>` blocks that mypa parses post-stream. |
| `getChatThread` | `(id) → ChatMessage[]` | Fetch the "Chat about it" streaming conversation thread for an intent. Messages may carry an optional `action: ProposedChatAction` field when the assistant proposed a write action. Available on all intents including terminal/failed ones. |
| `cancelChatStream` | `(id) → void` | Cancel an active "Chat about it" stream for an intent. |
| `approveChatAction` | `(intentId, messageId, editedPayload?) → ProposedChatAction` | Approve and execute a pending write action proposed in a chat message. Optionally pass a user-edited payload (e.g. edited comment text). Executes via `callTool` in-process and records trust accumulation. Returns the updated `ProposedChatAction` with `status: 'executed' \| 'failed'` and a `resultText` snippet. |
| `dismissChatAction` | `(intentId, messageId) → ProposedChatAction` | Dismiss a pending write action proposed in a chat message. No trust tier change (matches `recordDismissal` semantics). Returns the updated action with `status: 'dismissed'`. |
| `getDigest` | `(slot?) → AmbientDigest` | Fetch the latest digest for a slot (`morning \| midday \| eod`) |
| `getTrayState` | `() → TrayState` | Current tray state: `idle \| has-something \| needs-you` (driven only by `action`-type intents) |
| `getPolicy` | `() → AutonomyPolicy[]` | All per-action-type trust policies |
| `setTier` | `(actionType, tier, locked?) → void` | Manually set (and optionally lock) the trust tier for an action type |
| `resetTrust` | `() → void` | Reset all autonomy policies to defaults |
| `pollNow` | `() → void` | Trigger an immediate ambient poll cycle |
| `getLog` | `(limit?) → ActionLogEntry[]` | Recent autonomy event log |
| `startAuthoring` | `(intentId) → WorkProduct` | Start (or resume watching) the code-authoring run for an approved `author_fix` intent — creates an isolated worktree, runs the authoring agent, and captures the resulting diff. Idempotent: returns the existing work product if one already exists. Marks the intent `approved` as a side effect. |
| `getWorkProduct` | `(intentId) → WorkProduct \| null` | Fetch the work product backing an `author_fix` intent, if authoring has started |
| `shipWorkProduct` | `(intentId) → Intent` | Push the branch, open the PR, comment on the originating ticket, and notify Slack if a channel was identified. Validates required fields for every planned step before any external call runs. Returns the intent with `status: 'executed'` on full success. |
| `discardWorkProduct` | `(intentId) → void` | Abandon a work product — prunes the worktree (and local branch) and dismisses the intent |

### `chat`

Real-time resolution of in-stream agent decisions — tool approvals and user questions.

| Method | Signature | Description |
|---|---|---|
| `resolveToolApproval` | `(approvalId: string, allow: boolean, editedInput?: Record<string, unknown>) → void` | Unblock a pending write-tool gate. `allow: false` causes the SDK to skip the tool call. Pass `editedInput` to send a user-modified version of the tool arguments. |
| `answerQuestion` | `(questionId: string, answer: string) → void` | Unblock a pending `ask_user` tool invocation with the user's chosen answer. The stream resumes immediately after this call. |

IPC channels: `chat:resolve-tool-approval`, `chat:answer-question`.

---

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
| `ambient:work-product-updated` | `WorkProduct` | An `author_fix` work product's lifecycle status changed (drafting → ready → shipping → shipped/failed/abandoned) | widget only |
| `ambient:chat-user-message` | `{ intentId: string; message: ChatMessage }` | User message persisted to an intent's "Chat about it" thread (fires immediately before streaming begins) | **widget + main** |
| `ambient:chat-message` | `{ intentId: string; chunk: string; done: boolean; error?: string }` | Streaming chunk for an intent's "Chat about it" reply. `done: true` signals completion or error. | **widget + main** |
| `chat:tool-approval-request` | `PendingToolApproval` | An agent stream reached a write tool and is paused waiting for user approval. The renderer should show an inline approval UI. Resolved by calling `window.electron.chat.resolveToolApproval(approvalId, allow, editedInput?)`. | **widget + main** |
| `chat:ask-question` | `PendingQuestion` | The model called the `ask_user` tool and the stream is paused waiting for the user's selection. The renderer shows clickable option chips. Resolved by calling `window.electron.chat.answerQuestion(questionId, answer)`. | **widget + main** |
| `oauth:device-code` | `{ entryId: string; userCode: string; verificationUri: string }` | A device-code login (`oauth.startDeviceLogin`) reached its MSAL device-code prompt. The renderer shows the code and opens `verificationUri` (also auto-opened in the system browser by the main process). | main only |

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
| `checkin:status-changed` | `CheckIn` | Session status changed (extracting → complete / error, or active → dismissed when superseded by a newer session) |
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
type WorkProductStatus = 'drafting' | 'ready' | 'shipping' | 'shipped' | 'failed' | 'abandoned'
```

### `checkin`

Manage PA check-in sessions and their chat threads.

| Method | Signature | Description |
|---|---|---|
| `start` | `() → CheckIn` | Start a new check-in — if an active session already exists and the user has replied to it, returns that session unchanged; otherwise supersedes it (`status: 'dismissed'`) and starts a fresh one |
| `getActive` | `() → CheckIn \| null` | Get the current active session, if any |
| `getAll` | `(limit?) → CheckIn[]` | List all sessions, newest first |
| `getThread` | `(checkinId) → ChatMessage[]` | Fetch full message thread for a session |
| `sendMessage` | `(checkinId, message) → void` | Send a user message (streaming) |
| `end` | `(checkinId) → void` | End the session and trigger async knowledge extraction |
| `cancelStream` | `(checkinId) → void` | Cancel active streaming response |
| `openInMainWindow` | `(checkinId?) → void` | Open main window on Check-in page, expanding the given session |

## Changelog

- 2026-07-23 — **Add Outlook device-code sign-in: `oauth.startDeviceLogin` + `oauth:device-code` push channel.** New `IpcApi.oauth.startDeviceLogin(entryId, env)` (channel `oauth:start-device-login`) runs a catalog entry's own login command and resolves once it exits — used by the new `outlook` connector, whose MCP server manages its own Microsoft token cache/refresh rather than mypa performing an OAuth handshake. New push channel `oauth:device-code` (`{ entryId, userCode, verificationUri }`) delivers the MSAL device code to the renderer as it appears in the login process's output. `AppConfig` gains `device_login_at?: Record<string, string>` (display-only "Connected on <date>" timestamp, not a credential). See [mcp-and-oauth.md](mcp-and-oauth.md#outlook--device-code-flow).

- 2026-07-23 — **`repos` namespace switches from manual add/remove to code-root auto-discovery.** `repos.add`/`repos.remove` removed; added `repos.getCodeRoots`, `repos.addCodeRoots`, `repos.removeCodeRoot`, `repos.rescan`. `repos.getAll`/`repos.update` unchanged in shape, but discovered `RepoLink`s now default `authoringEnabled: false` and carry `source`/`lastSeenAt`. See [services.md](services.md#changelog) for the scan/reconciliation details.

- 2026-07-22 — **Removed GitHub OAuth device-flow IPC.** `oauth:start-device`/`oauth:poll-device` channels and their preload bindings (`oauth.startDevice`/`oauth.pollDevice`) are removed — GitHub is now a PAT/`api_key` catalog entry, not OAuth (org OAuth-app access-control policies could block the device flow). `IpcApi.oauth` now only exposes `startPkce` (Notion/Linear). See [mcp-and-oauth.md](mcp-and-oauth.md#github--personal-access-token).

- 2026-07-13 — **Obsidian vault knowledge source: new `knowledge` namespace + `IntentSurface`/`AppConfig` additions.** New `IpcApi.knowledge.listVaultFolders(path)` channel (`knowledge:list-vault-folders`) lists top-level subfolders for the Settings vault-folder picker. `IntentSurface` gains `'obsidian'` — a context-only surface, intentionally excluded from `VALID_SURFACES` (inference.ts) so vault notes are never a proposable action target. `AppConfig` gains `knowledge?: KnowledgeConfig` (`{ vault?: { path, folders, enabled } }`), read/written via the existing `config.get`/`config.update`. See [knowledge-graph.md](knowledge-graph.md) and [services.md](services.md).

- 2026-07-09 — **Code authoring: new `repos` namespace, `ambient` authoring methods, `work-product-updated` push channel.** New `IpcApi.repos` namespace (`getAll`, `add`, `update`, `remove`) backed by `repos.ts` — registers a local git checkout as a `RepoLink`. New `RepoLink`/`WorkProduct`/`WorkProductStatus` types and `repos?: RepoLink[]` on `AppConfig` in `src/shared/types.ts`. `IpcApi.ambient` gains `startAuthoring(intentId)`, `getWorkProduct(intentId)`, `shipWorkProduct(intentId)`, `discardWorkProduct(intentId)`, backed by the new `authoring.ts` service. New push channel `ambient:work-product-updated` (payload: `WorkProduct`). See [code-authoring.md](code-authoring.md).

- 2026-06-30 — **`config:get-scope-candidates` channel + `config:update` scope editing.** New read-only `config:get-scope-candidates` IPC channel (handler in `ipc-handlers.ts`, exposed in preload as `window.electron.config.getScopeCandidates()`). Returns `Record<string, string[]>` — distinct identifiers per surface derived from the knowledge graph, unioned with any currently configured identifiers. Used by the Settings scope multi-select to populate toggle chips. `config:update` now accepts user-edited `scope.allowed` (the Settings UI writes the full map on each toggle). `ScopeConfig` doc comment updated: allowlist is now also editable via Settings, not only check-in extraction.

- 2026-06-26 — **`Intent.actions` field:** `Intent` in `src/shared/types.ts` gains `actions?: McpActionRef[]` (mirrors `PlanItem.actions`). Populated by `inferDeepIntent` when agentic enrichment produces concrete tool call proposals. Persisted in `intents.actions` (new DB column). Included in all `ambient:*` push channels and `ambient.getIntents`/`ambient.getAllIntents` responses unchanged (IPC serializes the full Intent object). `IntentObject` also gains `actions?: McpActionRef[]` (input side, from model response) and `UsageSource` gains `'review'`.

- 2026-06-25 — **`McpServerConfig` shape changes + server enable/disable + HTTP/SSE transport.** `McpServerConfig` (in `src/shared/types.ts`) gains three new optional fields: `enabled?: boolean` (omit or `true` = active; `false` = disabled but retained in config), `transport?: 'stdio' | 'http' | 'sse'` (defaults to `'stdio'` when `command` is present, `'http'` otherwise), and `url?: string` (required for http/sse), `headers?: Record<string, string>` (optional auth header). `command` is now optional (absent for remote servers). `McpServerStatus` gains `disabled?: boolean`. `SetupHealthServer` gains `disabled?: boolean`; when `disabled`, `setup:get-health` returns early for that server (no env/path validation). `DetectedMcpServer` gains `url?: string`; `supported` is now true for http/sse entries from Claude Code config. `IntentSurface` extended with `'linear'`.

- 2026-06-25 — **`memory.getActive` — flat active-memory list:** Added `memory:get-active(limit?)` IPC channel (handler in `ipc-handlers.ts`, exposed in preload). Returns all non-superseded memories sorted by `importance DESC`, capped at `limit` (default 10). Used by the `LearnedProfileSection` in Settings to surface learned preferences. `IpcApi.memory.getActive(limit?)` added to `src/shared/types.ts`.

- 2026-06-22 — **Agent SDK migration — new `chat` namespace + push channels:** Added `IpcApi.chat` namespace with `resolveToolApproval(approvalId, allow, editedInput?)` and `answerQuestion(questionId, answer)` (IPC channels `chat:resolve-tool-approval`, `chat:answer-question`). Added push channels `chat:tool-approval-request` (payload: `PendingToolApproval`) and `chat:ask-question` (payload: `PendingQuestion`). Added `PendingToolApproval` and `PendingQuestion` interfaces to `src/shared/types.ts`.

- 2026-06-19 — **Plan-chat write-action approval:** `plan.approveChatAction(itemId, messageId, editedPayload?)` and `plan.dismissChatAction(itemId, messageId)` added to `IpcApi.plan`. IPC channels: `plan:approve-chat-action`, `plan:dismiss-chat-action`. `PlanItemCard` and `PlanItemDetail` now pass `onApproveAction`/`onDismissAction` to `<ChatThread>`.

- 2026-06-18 — **Live MCP in chat + in-chat write actions:** All streaming chat paths (`handleIntentChat`, `handleRunMessage`, `handlePlanMessage`, `handleCheckInMessage`, check-in briefing) now pass `enableMcp: true` to `streamChat`, which wires `--mcp-config` + `--allowedTools` into the spawned claude CLI. Read-only tools are pre-approved; the allowed-tools list is built from `getKnownServerTools()` (survives dead in-process clients via `lastKnownTools` cache). When the model proposes a write action in an intent chat via `<action>{...}</action>`, mypa parses it post-stream, merges parent-intent routing identifiers, computes the trust tier, and either auto-executes (tier 0) or persists it as a pending action on the chat message (`intent_chat_threads.metadata`). New IPC: `ambient.approveChatAction(intentId, messageId, editedPayload?)` and `ambient.dismissChatAction(intentId, messageId)`. New push channels `ambient:chat-message` and `ambient:chat-user-message` added to the typed `on()` union. `ChatMessage` gains optional `action?: ProposedChatAction`; renderer shows Approve/Dismiss chips with editable draft text.

- 2026-06-17 — **Button trimming — merge Suggest into Chat:** removed `ambient.suggest` and `ambient.getIntentThread` IPC methods (and the `ambient:intent-message` push channel that backed Suggest replies). Added `ambient.reviseFromChat(id)` — a one-shot call that runs `reproposeIntent` over the full Chat thread and returns `{ intent, applied, message }`. The Suggest conversational path is now unified into the Chat panel via an opt-in "Update the proposal" button that calls `reviseFromChat`.

- 2026-06-22 — **Auth-source IPC:** `setup:check-prerequisites` return shape changed from `{ claudeCli: boolean }` to `{ ok: boolean; source: AuthSource }` where `AuthSource = 'apikey' | 'env' | 'cli-login' | 'none'`. `SetupHealth.claudeCli: boolean` replaced by `SetupHealth.auth: { ok: boolean; source: AuthSource }`. New `AuthSource` type exported from `@shared/types`.

- 2026-06-17 — **Ambient insight chat + routing fix:** Added three new `ambient` IPC methods (`sendChatMessage`, `getChatThread`, `cancelChatStream`) and two new push channels (`ambient:chat-user-message`, `ambient:chat-message`) for a streaming per-intent "Chat about it" conversation thread backed by `intent_chat_threads` DB table. Also fixed GitHub/Jira intent actions failing with `-32603` by introducing `enrichPayloadForRouting` (which injects `_owner`/`_repo`/`_issue_number` for GitHub, `_issue_key` for Jira at intent-creation time) and a pre-flight schema validation guard in `executeIntent` that surfaces a clear human error instead of a raw MCP error when required args are still missing.

- 2026-06-17 — **`RoutineRun` gains `covered_entities: CoveredEntity[]`:** the `RoutineRun` payload emitted by `routine:run-completed` and returned by `routines.getAllRuns`/`getRuns` now carries a `covered_entities` field — an array of `CoveredEntity` snapshots (`{ key, surface, kind, external_id, title, url }`). `key` matches graph-node and insight focus-node keys (`surface:kind:external_id`), enabling renderer-side insight↔run linkage with no extra IPC calls. The field is always present (empty array `[]` for runs without detected entities or runs completed before this change). New `CoveredEntity` interface in `src/shared/types.ts`. Widget `App.tsx` continues to call `ambient.getIntents()` on mount; the linkage index is derived from the same pending-intents state with no extra IPC calls.

- 2026-06-16 — **MCP connection reliability:** replaced ephemeral `config:test-mcp-server` with `config:reconnect-mcp-server(name)` (reconnects the live connection Map — "Test connection" now updates the dot and tool count) and `config:reconnect-all()` (re-probes all servers, used by the Re-check button so it no longer just reads stale cache). Removed `testServer` from `mcp.ts`. Added connection-mutation mutex to `mcp.ts` so concurrent `config:update` calls cannot race each other's `connectAllServers` and produce "Connection closed" errors. Added Slack stale-config migration in `connectAllServers` (detects saved entries without `--transport` and rewrites args).
- 2026-06-16 — settings menu hardening: `config.update` return type corrected to `AppConfig` (was `void`); main-process `system:get-window-type` handler removed (dead code — preload resolves window type from `window.location.pathname`); `config:update` handler now defensively strips `apiKey` from the incoming partial so the dedicated `config:set-claude-key` channel remains the sole write path for the API key; OAuth App Credentials card gains a per-card Save button that calls `handleCredentialSave` (stamps `oauth_connected_at`) instead of requiring the page-level Save.
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
