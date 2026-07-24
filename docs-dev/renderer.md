# Renderer

mypa has two separate Electron renderer windows, each a React 18 SPA. They share the same preload script (`src/preload/index.ts`) and IPC API (`window.electron`), but load different HTML entry points.

**Path alias:** `@renderer` → `src/renderer/src/` (renderer only).

---

## Widget window

- **Entry:** `src/renderer/widget.html` → `src/renderer/src/widget/App.tsx`
- **Size:** 380 × 580 px, frameless, no native chrome
- **Behaviour:** always running (hidden initially); appears when the user clicks the system-tray icon; can be pinned always-on-top via preferences

### Top-level structure

```
widget/App.tsx
  ├── SetupBanner          — shown until onboarding_complete = true
  ├── TabStrip             — Routines / Plan / Ambient tabs
  ├── <tab content>
  └── QuickAddBar          — freeform intent input at bottom
```

### Tabs

#### Routines tab

| Component | Description |
|---|---|
| `RoutinesFeed` | Scrollable list of recent routine runs |
| `RoutineCard` | Single run — shows routine name, digest summary, proposed actions, status badge |
| `ChatThread` | Inline streaming chat for a run's follow-up conversation |

Data flow: `window.electron.routines.getAllRuns()` on mount; push events `routine:run-started`, `routine:run-completed`, `routine:run-message` for live updates.

#### Plan tab

| Component | Description |
|---|---|
| `PlanList` | All plan items grouped or sorted by timing/status |
| `PlanItemCard` | Single item — title, detail, status controls, timing badge, chat thread toggle |
| `PlanReviewCard` | Confirmation card for an AI-generated `PlanDraft` — shows parsed fields, allows editing before confirming |
| `ChatThread` | Shared component for inline streaming chat |

Data flow: `window.electron.plan.getAll()` on mount; push event `plan:item-message` for live streaming.

#### Ambient tab

| Component | Description |
|---|---|
| `DigestView` | Renders the latest `AmbientDigest` — three sections: did / watching / decisions |
| `QueueView` | Scrollable list of pending/surfaced action intents and active plan items |
| `IntentCard` | Single intent — rationale, proposed action, confidence badge, Approve / Dismiss / Challenge / Chat controls; Chat opens a streaming `ChatThread` for free-form discussion; an opt-in "Update the proposal" button inside Chat calls `reviseFromChat` for active action intents |
| `WorkProductCard` | Renders in place of `IntentCard` for `author_fix`-verb intents (`QueueView.renderIntentCard` branches on `intent.verb`). Shows the code-authoring lifecycle — no work product yet ("Attempt a fix?" + Start), `drafting` (in progress), `ready` (diff summary, file list, expandable raw diff, Ship it / Discard), `shipping`, `shipped` (PR link), `failed`. See [code-authoring.md](code-authoring.md). |

Data flow: `window.electron.ambient.getIntents()` + `getDigest()` on mount; push events `ambient:intent-created`, `ambient:intent-updated`, `ambient:tray-state`, `ambient:digest-ready`, `ambient:chat-user-message`, `ambient:chat-message`, `ambient:work-product-updated` (`WorkProductCard` only, filtered by `intent_id`).

### QuickAddBar

Free-text `<textarea>` at the bottom of the widget (converted from `<input type="text">`). Auto-grows 1–4 rows via `useAutoGrowTextarea`. Calls `window.electron.plan.createDraft(intent)` → shows `PlanReviewCard` for confirmation → `window.electron.plan.confirm(draft)` to persist. Enter submits; Shift+Enter inserts a newline.

### Shared hooks

`src/renderer/src/hooks/useAutoGrowTextarea(value, maxRows = 4)` — ref-based textarea auto-grow hook. On every `value` change: resets `height='auto'`, reads `scrollHeight`, clamps to `maxRows` lines (computed from `lineHeight` + padding), sets `overflow-y: auto` when content overflows the cap, `hidden` otherwise. Applied to: `ChatThread` chat input, `IntentCard` draft and challenge textareas, `PlanReviewCard` detail textarea, and `QuickAddBar`.

**Live-data hooks** — `useLiveRuns(limit)`, `useLiveIntents(scope, limit)`, `useLivePlanItems()`. Each owns one entity end-to-end for both renderer windows: fetch on mount, upsert-by-id on the entity's push events, and a refetch on `window`'s `focus` event as a self-healing safety net for any push event missed while the window was unfocused. Each returns `{ <items>, set<Items>, loading, refetch }` — the raw `useState` setter is handed back so existing full-array callbacks (`onRunsChange`, `onIntentsChange`, `onItemsChange` on `RoutinesFeed`/`QueueView`) keep working unchanged. `useLiveIntents('pending' | 'all', limit?)`: `'pending'` calls `ambient.getIntents()` (widget Queue tab); `'all'` calls `ambient.getAllIntents(limit)` (main window's Insights page, which derives Queue/Observations/History from one full list). Every refetch merges the fetched list with any local entries not yet present in it, so a live-added item is never clobbered by a fetch that raced ahead of DB consistency. UI-only reactions to an entity's events (e.g. the widget switching tabs when a new actionable intent arrives) stay as small dedicated listeners in the consuming component — the hooks own data only, not navigation.

Used by: widget `App.tsx` (all three), main window `RunLogs.tsx` (`useLiveRuns`, replacing a mount-only fetch that never refreshed the open "Needs you" list — see [Routines](#routines)), and `InsightsPage.tsx` (`useLiveIntents('all', 200)` + `useLivePlanItems()`).

### Sidebar unread badges

`main-window/App.tsx` computes per-page unread counts on mount and via push events (`ambient:intent-created`, `ambient:intent-updated`, `plan:item-updated`, `badge:updated`):
- **Insights** — pending action intents + active (non-done/skipped) plan items.
- **Routines** — `pending_response` routine runs. This count is passed as `pendingCount` into `RoutinesPage` and also drives the **Needs you** sub-tab's count badge, so the sidebar badge and the sub-tab badge always show the same number.

Each nav item renders a `.nav-item__badge` count pill (CSS in `index.css`) when its count > 0. Badges clear in real-time as the user acts.

---

## Main window

- **Entry:** `src/renderer/main-window.html` → `src/renderer/src/main-window/App.tsx`
- **Size:** resizable, standard window chrome
- **Dev note:** load is intentionally delayed 2 s in dev mode to avoid Vite cold-start burst

### Top-level structure

```
main-window/App.tsx (exports App → ToastProvider + AppShell)
  ├── ToastProvider         — global toast context + portal-rendered ToastContainer
  ├── AppShell
  │     ├── Sidebar nav (6 items: Routines, Insights, Check-in, Memory, Usage, Settings)
  │     ├── OnboardingWizard    — shown if onboarding_complete = false
  │     └── <page content>
  └── ToastContainer        — fixed top-right portal; renders Toast items
```

### Toast system

`src/renderer/src/main-window/toast/ToastProvider.tsx` provides a global, portal-rendered toast stack for the main window.

**API** (via `useToast()` hook):

```ts
const toast = useToast()
const id = toast.show({ variant, title, message?, action?, duration? })
toast.update(id, patch)          // e.g. loading → success/error
toast.dismiss(id)
toast.success(title, opts?)      // auto-dismiss 4 s
toast.error(title, opts?)        // auto-dismiss 8 s
toast.info(title, opts?)         // auto-dismiss 4 s
toast.loading(title, opts?)      // sticky (duration: 0); update when done
```

Variants: `success` (green), `error` (red), `info` (accent purple), `loading` (yellow spinner).  
Toasts support an optional `action: { label, onClick }` button (e.g. "View" that navigates to the Needs you sub-tab of the Routines page).

**Background-event bridge** (`useRunToasts` in `App.tsx`): subscribes to `routine:run-started` (→ loading toast), `routine:run-completed` (→ update to success/error; "View" action switches to the Needs you sub-tab), and `ambient:action-executed` (→ info toast). This is why clicking **Run now** in RoutinesManager now shows visible feedback — the run events are broadcast to both windows (see IPC docs).

Styles in `src/renderer/src/main-window/index.css` (`.toast*` block), using existing design tokens. Timer cleanup on unmount prevents leaks.

### Pages

#### Routines

`RoutinesPage` is the nav-level wrapper; it owns the page header and a three-tab strip. The sidebar Routines badge count equals the "Needs you" sub-tab count (both = `pending_response` runs), giving a precise drill-down from badge to inbox.

| Tab | Component | Description |
|---|---|---|
| **Needs you** (first) | `RunLogs` (`filterStatuses=['pending_response','in_progress']`) | Inbox of runs waiting for a response; shows a count badge matching the sidebar badge |
| **Routines** | `RoutinesManager` | List of all saved routines with enable/disable toggle and run-now button; "+ New routine" action row at top |
| **Run Logs** | `RunLogs` (unfiltered) | Full history of all routine runs regardless of status |

Additional components:

| Component | Description |
|---|---|
| `RoutinesPage` | Outer shell: page header ("Routines"), three-tab `<Tabs>` strip, `pendingCount` prop drives the Needs you count badge |
| `RoutineForm` | Create / edit a routine: name, cron expression (with human-readable preview via `cronUtils.ts`), MCP actions, digest prompt |
| `ServerCatalogPicker` | Browse and add servers from the built-in MCP catalog; each add path (`ConfigurePanel`, `ImportPanel`, `CustomServerPanel`) shows a disabled/spinner `saving` state while `onAdd` is in flight |
| `RunLogs` | Table of routine runs, backed by [`useLiveRuns(50)`](#shared-hooks) so the list stays current (including the "Needs you" tab) while the page is open, not just on remount; click a row to expand; expanded view has "Conversation" (default) / "Raw output" toggle; Conversation tab shows **Dismiss** / **Mark resolved** action buttons; optional `filterStatuses` and `emptyMessage` props |

Navigation:
- Clicking **Routines** in the sidebar → auto-opens **Needs you** if `routinesBadge > 0`, otherwise lands on **Routines** tab.
- `navigate:edit-routine` → opens the Routines sub-tab and opens `RoutineForm` in edit mode.  
- `navigate:run-chat` → opens the Run Logs sub-tab and auto-expands the target run in conversation view (uses 'logs' so that resolved/dismissed runs from stale notifications are still reachable).  
- "View" toast action → navigates to the Needs you sub-tab.

**Unsaved-Settings navigation guard:** sidebar clicks and the IPC-driven `navigate:*` listeners (`navigate:edit-routine`, `navigate:plan-item`, `navigate:run-chat`, `navigate:checkin`) both go through `AppShell`'s `requestNavigate(next, after?)` instead of calling `setPage` directly — a background push event arriving mid-edit shows the same confirm overlay as a sidebar click would, rather than silently discarding the edit. If `next !== page` and the current page is `'settings'` with `Settings` having reported `onDirtyChange(true)` (tracked as `settingsDirty`), `requestNavigate` stores `{ page, after }` in `pendingNavigation` and shows a confirm overlay ("Unsaved changes" / Cancel / Discard & leave) instead of navigating immediately; confirming calls `setPage` and runs the deferred `after` callback (e.g. the Routines sub-tab logic). The `next !== page` check specifically avoids popping the confirm overlay when the already-active page is reselected (e.g. clicking the Settings nav item again while dirty). Because the IPC listeners subscribe once on mount (`[]` deps) but `requestNavigate` is a fresh closure each render, they call through `requestNavigateRef` (kept current via a no-deps `useEffect`) rather than the function directly, avoiding a stale closure that would otherwise pin `page`/`settingsDirty` to their mount-time values forever. Toast-action jumps still call `setPage` directly and are not guarded.

#### Insights

`InsightsPage` surfaces the agent's ambient intelligence in a structured layout:

1. **Queue tab (first):** reuses the widget's `QueueView` component to render the full actionable queue — pending `action`-type intents ("Needs you") and active plan items — with working Approve / Dismiss / Challenge / Chat actions. A count badge on the Queue tab reflects `pendingActionIntents + activePlanItems`. Intents and plan items come from the shared [`useLiveIntents('all', 200)` / `useLivePlanItems()`](#shared-hooks) hooks.
2. **Daily Digest (always on):** `DigestView` sits above the tabs, always visible, with its morning / midday / end-of-day slot selector. Any non-terminal `digest`-type intents are listed directly below it under "Recent digests".
3. **Observations tab:** non-terminal `flag`/`suggestion` intents.
4. **History tab:** full history of terminal intents (executed, dismissed, challenged, failed, expired).
5. **Activity tab:** chronological action log (`ambient.getLog`) — one row per event the agent recorded (surfacing, execution, approval, challenge, dismissal). Refreshes live on `ambient:action-executed`.

**Poll now button:** a small ghost button in the page header calls `ambient.pollNow()` with idle → "Polling…" → "Polled" three-state feedback. `pollNow` awaits the full poll+inference cycle before resolving, so new signals and intents appear as soon as the button confirms.

| Component | Description |
|---|---|
| `InsightsPage` | Outer shell: page header with Poll now button, Queue / Observations / History / Activity `<Tabs>` strip, `ActivityLog` sub-component |
| `ActivityLog` | Inline component rendering `ActionLogEntry[]` as a compact timestamp · event · action_type · tier grid |
| `QueueView` | Shared widget+main component: "Needs you" action intents + active plan items + Done section; supports Approve / Dismiss / Challenge / Chat actions |
| `DigestView` | Self-contained: fetches and renders the `AmbientDigest` for the selected slot; has its own slot selector and re-fetches on `ambient:digest-ready` |
| `IntentCard` | Single intent card with Approve / Dismiss / Challenge / Chat actions; shared with widget |

Data flow: intents and plan items via `useLiveIntents('all', 200)` / `useLivePlanItems()` (mount fetch + push-event upsert + focus refetch, see [Shared hooks](#shared-hooks)); `window.electron.ambient.getLog(100)` on mount, refreshed on `ambient:action-executed`; `ambient:digest-ready` handled inside `DigestView`.

#### Plan item detail

| Component | Description |
|---|---|
| `PlanItemDetail` | Full-height chat view for a single plan item; no height cap on the conversation |

Reached via `navigate:plan-item` push event (sent by `plan.openInMainWindow`). Renders a "Back to plan" button that returns to the Routines page. The sidebar shows a transient "Plan item" nav entry while this page is active.

#### Memory (Knowledge Graph)

| Component | Description |
|---|---|
| `MemoryGraph` | Force-directed canvas (`react-force-graph-2d`); node size ∝ weight; click to select |
| `NodeDetailPanel` | Right-side panel showing the selected node's type, label, attrs, edges, memories, and signal timeline |

Interactions:
- **Click node** → open `NodeDetailPanel`.
- **Delete node** → calls `window.electron.memory.deleteNode(id)`; node and cascade edges removed.
- **Delete edge** → calls `window.electron.memory.deleteEdge(id)`.
- **Edit/delete memory** → calls `window.electron.memory.updateMemory` / `deleteMemory`.
- **Export** → header Export button calls `window.electron.memory.exportMarkdown()`; shows a system save-file dialog; writes a Markdown export package to the chosen path.

Data: `window.electron.memory.getGraph()` on mount; `getNode(id)` on selection.

#### Usage

| Component | Description |
|---|---|
| `UsageDashboard` | Token usage and estimated cost dashboard; all data recorded from mypa install forward |

Layout:
- **Range selector** — segmented control (7d / 30d / 90d / All); re-fetches all five IPC calls on change.
- **Stat grid** — 4 `.stat-card`s: Est. cost, Total tokens, Total calls, Avg cost/call.
- **Bar chart** — SVG bar chart of daily usage (toggle cost/tokens); custom-drawn with existing CSS tokens; no chart library dependency.
- **By feature** — proportion-bar breakdown rows grouped by `UsageSource`.
- **By model** — same pattern grouped by model id.
- **Recent calls** — last 30 individual `UsageEvent`s with source, model, token counts, cost, and relative time.

Data: `window.electron.usage.*` — all five calls made in parallel on mount and on range change.

#### Settings

| Component | Description |
|---|---|
| `Settings` | Single scrolling settings panel with **one Save affordance**: a sticky "Unsaved changes" bar (Discard / Save changes) that appears only while a governed field differs from the last-saved config, and disappears on save. `Settings` computes `isDirty` by diffing a `governedSlice(config)` (owner, persona, preferences, oauth_apps, checkin, knowledge.vault — plus a pending API key) against a `savedBaseline` snapshot taken on load and refreshed after each save; `handleSave` persists that same slice in one `config.update()` call (plus `oauth_connected_at` stamping for any changed OAuth credential). Reports dirtiness upward via an `onDirtyChange` prop so `App.tsx` can guard navigating away (see below). Ambient Autonomy tiers, Working Context scope, and MCP/Repos add-remove intentionally stay instant-apply (no Save needed) — see their rows below. |
| — MCP tab | Add/edit/remove MCP servers; test connection; import from Claude Code config. Add/remove/enable-disable persist immediately (live connection tests), independent of the main Save. |
| — Repos section (`ReposSection`) | Two cards, both instant-apply via `repos.*` IPC. "Code roots" — parent folders to scan (`pickDirectory(true)` multi-select Add folder button, per-root Remove, a Rescan button) via `getCodeRoots`/`addCodeRoots`/`removeCodeRoot`/`rescan`. "Discovered repos" — read-only list from `repos.getAll()` (path, derived GitHub repo, a `manual` badge for pre-auto-discovery links) with an inline editable Jira-keys field and a per-repo `authoringEnabled` toggle (`repos.update`), off by default for every newly discovered repo. See [code-authoring.md](code-authoring.md). |
| — Knowledge Vault section (`VaultSection`) | Configure a local markdown vault (e.g. Obsidian) as a read-only knowledge source: vault path (`pickDirectory` Browse… button, `knowledge.listVaultFolders` to enumerate subfolders), a checkbox grid of vault-relative subfolders to ingest (unchecked folders — e.g. personal notes — are never read), and an enable toggle. Controlled component (`vault`/`onChange` props) — edits live in the parent `config.knowledge.vault` and persist through the main Save bar, not a card-local button. See [knowledge-graph.md](knowledge-graph.md#knowledge-vault-obsidian). |
| — Check-in Schedule section (`CheckInScheduleCard`) | Enable-toggle + `ScheduleBuilder` cron picker for scheduled check-ins. Controlled component (`checkin`/`onChange` props) — persists through the main Save bar, not a card-local button. |
| — OAuth tab | Connect Notion (PKCE) and Linear (PKCE); show connection status. GitHub is not here — it's a plain PAT field under the MCP tab (`api_key` catalog entry, no OAuth app to register). Client ID/secret fields are controlled by the top-level `config` and persist through the main Save bar (which also stamps `oauth_connected_at` for any changed provider); the card's own "Save" button was removed. `handleCredentialSave` still fires immediately for the inline credential form shown when adding a new OAuth-based MCP server (`ServerCatalogPicker`), and folds that save into `savedBaseline` so the sticky bar doesn't falsely flag it as pending. |
| — Claude tab | Model selector; displays current model |
| — Preferences tab | Widget always-on-top, notification sound, launch on login; persona text field |
| — About You card | Full identity hub with three sections: (1) Identity — monogram badge + name input; (2) Connected Accounts — one row per `visibleSurfaces` entry (an `OWNER_SURFACES`/`IDENTITY_SURFACES` surface with a matching enabled MCP server — unenabled surfaces like an unconfigured Linear/Notion aren't rendered at all, not even as a "not connected" placeholder) showing a surface badge, handle input, and a Verified/Confirm status pill from `handleStatus`; (3) Working Context — tabbed, searchable scope picker (`WorkingContextSection`): a per-service tab strip (using the shared `Tabs` component) shows only services whose MCP server is configured and not disabled (`enabled !== false`); the active tab's picker has a `form-input` search box that filters candidates client-side; selected-count badge on each tab; empty/no-match states handled; toggling a chip still saves immediately (instant-apply, excluded from the main Save's dirty check); (4) What mypa has learned — derived from `memory.getGraph()` + `memory.getActive()`: top active containers (`Active in`), collaborators (`Works with`), and preference memories (`Prefers`). Standalone `ScopeCard` component removed. |
| — Ambient Autonomy card (`AmbientAutonomyCard`) | Master enable toggle + per-intent-type trust tier controls. Both persist immediately via `config.update`/`ambient.setTier` — instant-apply, excluded from the main Save's dirty check. |

#### Onboarding wizard

`OnboardingWizard` walks first-time users through (5 steps):
1. Welcome.
2. **Connect Claude** — calls `setup:check-prerequisites` to probe for credentials (`AuthSource`). Shows the detected source (API key / env vars / Claude login, now including a macOS Keychain check — see [claude-integration.md](claude-integration.md#authentication)) or an inline API-key input field when none are found. Soft gate: Next is enabled once a source is detected or a key has been entered. Does NOT require a standalone Claude Code CLI binary.
3. Connecting MCP servers / OAuth providers. `ServerCatalogPicker`'s `ConfigurePanel` "Add {name}" button has a `saving` state (spinner + disabled) while `onAdd` is in flight, matching `ImportPanel`/`CustomServerPanel`. The wizard's own `handleAddServer` serializes adds through a `serversAddedRef`/`addingServerRef` guard so a repeat click can't race two `config.update` calls off a stale `serversAdded` snapshot, and rethrows on failure (after its own error toast) so the calling panel's `await onAdd(...); onBack()` correctly stays put — with the user's filled-in fields intact — instead of navigating back to the catalog as though the add had succeeded.
4. **About you** — name + per-surface handles with auto-fill button; saves to `AppConfig.owner`. Only shows a handle input for a surface if an enabled MCP server with that name was added in step 3 (or the surface already has a saved handle) — mirrors Settings' `OWNER_SURFACES`/`visibleSurfaces` filtering (see the About You card row above; both now import the shared `IDENTITY_SURFACES` vocabulary from `@shared/types` rather than each declaring their own copy). An empty-state hint replaces the grid when no eligible tools are connected yet.
5. All set — summary showing auth status, tool count, and identity.

Completes by setting `onboarding_complete: true` in config.

**Drag region during setup:** the main window is frameless-ish (`titleBarStyle: 'hiddenInset'` on macOS) and relies entirely on CSS `-webkit-app-region: drag` for window dragging — the only such region is `.sidebar` (`index.css`), which isn't rendered until `onboarding_complete` is `true`. A `.drag-strip` (a bare, full-width top strip, no interactive children) is rendered in both the pre-config "Loading…" state and the onboarding wrapper in `App.tsx`, so the window can be moved from first launch, not just after setup finishes. It's laid out as a normal flex item (`flex-shrink: 0`, real layout height) rather than absolutely positioned over the scrollable wizard content below it — an overlay would sit on top of whatever scrolls into that 44px band, making it unclickable (or trigger a window drag) instead; the scrollable content sibling uses `flex: 1; min-height: 0` so it's confined to the remaining space and its content can never render above the strip regardless of scroll position.

---

## Shared components

Located in `src/renderer/src/` (shared between widget and main window):

| Component | Description |
|---|---|
| `ChatThread` | Renders a `ChatMessage[]` history with a streaming-capable input box. When `chat:tool-approval-request` fires during a stream, an `InlineToolApproval` block appears inline in the live message; when `chat:ask-question` fires, a `QuestionChip` cluster appears. Both block the stream until resolved. |
| `InlineToolApproval` | Rendered inside `ChatThread` when a `PendingToolApproval` push event arrives. Shows the tool name and proposed arguments, with Approve / Deny buttons (and an optional editable input for the payload). Clicking Approve calls `window.electron.chat.resolveToolApproval(approvalId, true, editedInput?)`; Deny calls it with `allow: false`. Disappears once the stream resumes. |
| `QuestionChip` | Rendered inside `ChatThread` when a `PendingQuestion` push event arrives. Shows the model's prompt and one clickable chip per option. Clicking a chip calls `window.electron.chat.answerQuestion(questionId, answer)` and the stream resumes. Both single-select and multi-select modes are supported. |
| `cronUtils.ts` | Human-readable cron expression parser (used in `RoutineForm`) |
| `components/MarkdownText.tsx` | Renders a markdown string via `ReactMarkdown` + `remark-gfm` wrapped in `<div className="md-text">`. Handles external link clicks via `window.electron.system.openExternal`. Used in `IntentCard`, `DigestView`, and `ChatThread`. |
| `components/Tabs.tsx` | Reusable underline-tab strip. Props: `items: TabItem[]`, `active: string`, `onChange: (id: string) => void`. `TabItem` has `id`, `label`, optional `icon` and `count`. Active tab gets accent underline + bold; count shows a colored pill. CSS classes: `.tabs`, `.tab`, `.tab--active`, `.tab__count`, `.tab__count--active` (in `components.css`). |
| `components.css` | Shared component stylesheet imported by both renderer entry points before their window-specific `index.css`. Contains `.routine-card*`, `.intent-card*`, `.intent-detail*`, `.intent-chip*`, `.plan-review-card*`, `.review-field*`, `.section-header`, `.section-subheader`, `.tabs`, `.tab*`. |

## Changelog

- 2026-07-23 — **Repos auto-discovery UI; Connected Accounts hides unenabled surfaces; check-in shows a thinking indicator on start (`Settings.tsx`, `CheckInPage.tsx`).** `ReposSection` rebuilt: the old single-form add-by-path flow (`repos.add`, Browse…, per-repo Enable/Disable/Remove buttons) is replaced by a "Code roots" card (multi-select folder picker, per-root remove, Rescan button) and a read-only "Discovered repos" card with an inline Jira-keys field and an `authoringEnabled` toggle per repo — see [services.md](services.md#reposts--repo-links-code-authoring-targets) for the scan/reconciliation logic behind it. Connected Accounts' row loop now iterates `visibleSurfaces` (requires the identity surface's MCP server to be both present *and* `enabled !== false`) instead of the full `OWNER_SURFACES` list, so an unconfigured surface like Linear/Notion no longer renders a "not connected" placeholder row at all. `CheckInDetail` now sets `streaming: true` as soon as a freshly started, empty-thread `active` check-in is opened, so `ChatThread`'s existing thinking-dots bubble (previously only triggered by the first streamed chunk) appears immediately instead of an empty card while the opening briefing spins up.

- 2026-07-23 — **Fixed the Knowledge Vault card duplicating in Settings, and squashed headers in the routine-setup form.** `Settings.tsx` rendered `VaultSection` and `CheckInScheduleCard` as siblings both keyed `key={discardCount}` — an unintentional duplicate key among siblings. React explicitly documents duplicate sibling keys as producing unpredictable reconciliation (including duplicated DOM nodes), which matched the reported symptom: the Knowledge Vault card in a packaged build showed 2+ copies after a fresh launch and gained more with each subsequent Settings re-render (e.g. an MCP reconnect/health-check updating `status`/`health` state). Gave each a distinct key (`` `vault-${discardCount}` `` / `` `checkin-${discardCount}` ``) so Discard still remounts them but they no longer collide. Separately, `RoutineForm.tsx`'s "MCP Actions" and "Instructions" cards were crowded: `.card__header` (`index.css`) had no `gap`, so the "+ Add action" button ran into the MCP Actions subtitle, and the Instructions card's title/subtitle were direct flex children of the `space-between` header (not wrapped in a sub-`div` like every other card), pushing the title left and the subtitle right into overlap. Added `gap: 12px` to `.card__header`, wrapped the Instructions title+subtitle in a `div` to match the standard pattern, and gave the "+ Add action" button `flexShrink: 0` / `whiteSpace: 'nowrap'`.

- 2026-07-22 — **`ChatThread` auto-scroll now reveals tool-approval/question prompts (`ChatThread.tsx`).** The scroll-to-bottom effect depended only on `[messages, streamingContent]`, so when a stream paused to show `InlineToolApproval` or `QuestionChip` (both rendered inside the scrolled `.chat-thread` container, after the streaming/thinking block), the effect never re-fired — the user was left looking at the "thinking" dots at the old scroll position and had to scroll manually to discover the prompt. Added `pendingToolApproval`/`pendingQuestion` to the effect's dependency array so the container scrolls to reveal the prompt the moment it appears. `ActionChip` prompts were unaffected (message-attached, already trigger via `messages`). Fixes every surface that embeds this shared component: widget chat, `CheckInPage`, `RoutineCard`, `IntentCard`, `PlanItemCard`.

- 2026-07-22 — **GitHub OAuth device-flow UI removed from `ServerCatalogPicker.tsx`/`Settings.tsx`.** GitHub is now a PAT/`api_key` catalog entry (see [mcp-and-oauth.md](mcp-and-oauth.md#github--personal-access-token)), so it renders through the existing generic API-key field path with no bespoke UI. Removed: `DeviceFlowSection` component and its state (`deviceFlow`/`polling`/`handleOAuthDevice`) from `ServerCatalogPicker.tsx`'s `ConfigurePanel`; the GitHub reconnect "Connect" button, its device-code display, and the "OAuth App Credentials" GitHub Client ID card from `Settings.tsx` (that reconnect button was gated on the generic `authType === 'oauth'` check but only ever called the GitHub-only device-flow IPC, so it was already non-functional for Notion/Linear rows — removed rather than fixed, since neither provider needs a per-row reconnect button today). Notion/Linear's `PkceSection` path is unchanged.

- 2026-07-15 — **Fixed unstyled chat action chips (tool-approval / write-action prompts) in the main window.** All `.chat-action-chip*` rules (`--pending/done/failed/dismissed` variants, `__label`, `__target`, `__draft`, `__buttons`, `__result`) lived only in `widget/index.css`, which `main-window/main.tsx` never imports — so `InlineToolApproval`, `ActionChip`, and `QuestionChip` (all in `ChatThread.tsx`, shared by `CheckInPage`, `RunLogs`, and `PlanItemDetail`) rendered with no styling in the main window: the approval `<textarea>` fell back to raw browser defaults (white background, narrow, unstyled) instead of the intended full-width dark input. Moved the block from `widget/index.css` to the shared `components.css` (already imported by both `widget/main.tsx` and `main-window/main.tsx`) so it styles both windows from one source; no className changes needed.

- 2026-07-15 — **`InlineToolApproval` (`ChatThread.tsx`) — Approve was truncating write-tool calls to a single field.** `handleApprove` built the edited payload as `{ [approval.editableField]: draft }` — a brand-new object, not a merge — and sent it on **any** Approve click, not just an edited one, because `draft` is pre-seeded from `approval.editableValue` so `draft.trim()` is truthy unedited. For a tool with multiple required parameters (e.g. GitHub's `create_pull_request_review`: `owner`/`repo`/`pull_number`/`event`/`body`), this dropped every field but the editable one — the tool then rejected the call with the other parameters `undefined`. `canUseTool`'s `updatedInput: editedInput ?? inputRecord` fallback (see [claude-integration.md](claude-integration.md#tool-gating--canusetool)) couldn't rescue it since `??` only falls back on `null`/`undefined`, not an incomplete object. Fixed to spread `approval.toolInput` (already on `PendingToolApproval`) before overriding the edited field: `{ ...approval.toolInput, [approval.editableField]: draft }`.

- 2026-07-15 — **`CheckInPage.tsx` — handle the new `dismissed` check-in status.** Companion renderer change for the main-process fix in [services.md](services.md#checkints--pa-check-in-sessions) that makes a newer check-in supersede an old undealt-with one. `CheckInDetail` gained an `isDismissed` derived flag: it disables `ChatThread`'s send (added to the existing `sendDisabled` condition alongside `streaming`/`isExtracting`/`isComplete`/`isError`) and renders a "Superseded by a newer check-in" note, so a user can't type into a session the main process has already retired. `CheckInPage` gained a page-level `checkin:status-changed` listener (reusing the existing `handleCheckinUpdated` updater) — previously only `CheckInDetail`, mounted per expanded row, listened for this event, so a supersede firing on a row that isn't currently expanded (the common case, since the newly created session is the one that gets expanded) never reached the list; the row would keep showing a stale `active` status until the page was remounted. `StatusDot`/`statusTagVariant` and the row-list status-line ternary both handle `dismissed` — the dot/tag fall through to their existing muted/neutral default (no new visual case needed), and the status line gained an explicit "Superseded by a newer check-in" branch matching the style of the adjacent `error`/`extracting` branches.

- 2026-07-14 — **Fix widget/main-window state divergence — new shared live-data hooks; "Needs you" list never refreshed while open (`hooks/useLiveRuns.ts`, `hooks/useLiveIntents.ts`, `hooks/useLivePlanItems.ts` new, `RunLogs.tsx`, `InsightsPage.tsx`, `widget/App.tsx`).** Root cause of the reported symptom: `RunLogs.tsx` fetched its run list once on mount and subscribed to no run-lifecycle push events, so a routine completing in the background while the "Needs you" tab was already open never appeared in the list — only the toast and the sidebar badge (separately wired) updated; the list itself only refreshed on remount (tab switch). More broadly, every renderer list kept its own `useState` copy of server data patched by ad-hoc per-component listeners, so any component missing a listener silently went stale. Fixed by extracting the pattern into three [shared hooks](#shared-hooks) — `useLiveRuns`, `useLiveIntents`, `useLivePlanItems` — that each own fetch + push-event upsert + a window-focus refetch (self-healing net for any missed event) for one entity, used by both `widget/App.tsx` and the main window (`RunLogs.tsx`, `InsightsPage.tsx`). Also fixes a secondary bug where the widget's `routine:run-completed` handler was replace-by-id only (`prev.map`, never upsert) — a completed run whose `routine:run-started` was missed, or that fell outside the initial `getAllRuns(20)` fetch, silently never appeared; `useLiveRuns` upserts (prepends if not already present). See [services.md](services.md#ambientts--ambient-polling-loop) for the companion main-process fix (`ambient:tray-state`/`ambient:digest-ready` were widget-only). Post-review fixes: all three hooks' `refetch()` now `.catch()`, so a rejected IPC call sets `loading` false instead of leaving it stuck `true` forever; `useLiveIntents`'s local-entry-preserving merge (previously re-applied on every refetch) now tracks a `lastFetchIds` ref so it only protects entries new since the *previous* confirmed fetch — the original version re-added any locally-held intent missing from a fetch indefinitely, so a 'pending'-scope intent that transitioned to 'approved' (or any intent that aged out of a 200-row 'all'-scope fetch) kept reappearing on every window-focus refetch instead of actually dropping out.

- 2026-07-13 — **Onboarding wizard polish (`OnboardingWizard.tsx`, `ServerCatalogPicker.tsx`, `App.tsx`/`index.css`, `Settings.tsx`).** (1) The "About you" step's handle grid is now derived from enabled tools added during onboarding (or an already-saved handle) instead of a fixed 5-surface list, with an empty-state hint when nothing's connected — see [Onboarding wizard](#onboarding-wizard). The surface vocabulary is now the shared `IDENTITY_SURFACES` from `@shared/types`, replacing separately-declared copies in `OnboardingWizard.tsx` and `Settings.tsx`. (2) `handleAddServer` gained a ref-based re-entrancy guard and now rethrows on failure (after its own toast) instead of silently swallowing the error, so `ServerCatalogPicker`'s panels correctly stay open with the user's input intact on a real failure rather than navigating back to the catalog as if it had succeeded. `ServerCatalogPicker`'s catalog `ConfigurePanel` Add button gained a `saving` spinner state, so repeatedly clicking Add while a tool is being connected no longer races or gives no feedback. (3) A new `.drag-strip` region makes the main window draggable during the pre-config loading state and the whole onboarding flow, not just after `onboarding_complete` (previously the only drag region, `.sidebar`, didn't exist yet) — laid out as a real flex item rather than an absolute overlay, so it can't end up covering scrolled-in content on taller steps (e.g. the tool catalog).

- 2026-07-13 — **Settings: consolidated to a single Save (sticky bar) + navigation guard.** `Settings.tsx` — removed the three per-card "Save" buttons (OAuth App Credentials, Knowledge Vault, Check-in Schedule) and the header "Save changes" button; replaced with one sticky bottom "Unsaved changes" bar (Discard / Save changes) shown only while dirty. Added `governedSlice(config)` (owner, persona, preferences, oauth_apps, checkin, knowledge.vault) + a `savedBaseline` snapshot (captured on load, refreshed after every save) to drive `isDirty`; instant-apply controls (Ambient Autonomy tiers/master toggle, Working Context scope chips, MCP server/repo add-remove) are intentionally excluded from the diff and keep saving immediately, unchanged. `handleSave` now persists the governed slice and any `oauth_connected_at` stamp (for OAuth providers whose credentials changed) in a **single** `config.update()` call — folded into one write specifically so a later step can't fail after the slice already persisted and leave the sticky bar stuck open — and advances `savedBaseline` immediately after that write succeeds, before the separate API-key save. `VaultSection` and `CheckInScheduleCard` converted from self-contained components (their own `config.get()` + local save button) to controlled components (`vault`/`checkin` + `onChange` props) owned by the parent `config` state; both are now keyed on a `discardCount` counter (bumped by `handleDiscard`) so Discard forces a remount, resyncing `VaultSection`'s scanned folder list and the check-in `ScheduleBuilder`'s picker state to the reverted config instead of showing stale values. New `Settings` prop `onDirtyChange?: (dirty: boolean) => void`. `App.tsx` — added `settingsDirty`/`pendingNavigation` state and `requestNavigate(next, after?)`, gated on `next !== page` (so reselecting the already-active page while dirty doesn't pop the confirm overlay); sidebar clicks **and** the IPC-driven `navigate:*` listeners (`navigate:edit-routine`/`navigate:plan-item`/`navigate:run-chat`/`navigate:checkin`, via a `requestNavigateRef` to avoid a stale mount-time closure) now go through it instead of calling `setPage` directly, so a background push event mid-edit shows the same confirm overlay rather than silently discarding the edit. See [Settings](#settings) and the navigation-guard note under [Routines](#routines).

- 2026-07-13 — **New Settings `VaultSection` (Obsidian knowledge vault).** New `VaultSection` component in `Settings.tsx` (mirrors `ReposSection`'s add/browse pattern): a vault-path field with `system.pickDirectory()` Browse…, a checkbox grid of vault-relative subfolders (populated via the new `knowledge.listVaultFolders(path)` IPC call), and an enable toggle. Saves to `config.knowledge.vault`. See [knowledge-graph.md](knowledge-graph.md#knowledge-vault-obsidian).

- 2026-07-09 — **New `WorkProductCard` + Settings `ReposSection` (code authoring).** New `src/renderer/src/widget/components/WorkProductCard.tsx`, rendered by `QueueView.renderIntentCard` in place of `IntentCard` whenever `intent.verb === 'author_fix'` (both in "Needs you" and "Recently resolved"). Shows the authoring lifecycle (Start → drafting → ready-for-review diff + Ship it/Discard → shipping → shipped/failed), subscribing to the new `ambient:work-product-updated` push event filtered by `intent_id`. Reuses existing `routine-card`/`intent-chip`/`intent-detail__kv-pre` CSS — no new stylesheet. New `ReposSection` component in `Settings.tsx` (mirrors the MCP Servers card's add/list/remove pattern) lets the user register a local git checkout via `repos.add()`, using the existing `system.pickDirectory()` IPC for the folder picker. See [code-authoring.md](code-authoring.md).

- 2026-06-30 — **Settings: tabbed, searchable Working Context pickers + correct MCP enablement gating (`Settings.tsx:WorkingContextSection`).** `WorkingContextSection` now renders a per-service tab strip (shared `Tabs` component) instead of a vertical stack of all enabled surfaces. Each tab label shows the surface name (GitHub orgs / Jira projects / Slack channels) with a count badge of currently-selected items. Only services whose MCP server has `enabled !== false` appear as tabs; a disabled server's tab is absent and the active tab auto-falls-back to the first enabled surface. Each tab's picker includes a `form-input` search box that client-side-filters candidates by substring match (case-insensitive), following the `ServerCatalogPicker` pattern. Three empty states: no candidates observed yet, no candidates match the query, and none selected (all pass through). The chip toggle and `config.update` write-on-change are unchanged.

- 2026-06-30 — **Settings: editable scope multi-select (`Settings.tsx:WorkingContextSection`) + IntentCard title fix (`IntentCard.tsx`).** `WorkingContextSection` rewritten from read-only chip display to an editable toggle-chip multi-select. On mount it calls `window.electron.config.getScopeCandidates()` to load graph-derived candidate orgs/projects/channels (unioned with current selections so already-configured identifiers always appear). Per surface, renders a `btn btn--sm btn--primary/ghost` chip per candidate (matching the `InlineQuestion` toggle pattern in `ChatThread.tsx`). Toggling a chip saves immediately via `config.update({ scope: { allowed: fullMap } })` — the full map is always sent since `deepMerge` replaces arrays as leaves. Empty candidate + no selection shows an honest "no Xs observed yet" hint. `IntentCard.tsx` — card title now derived from `titleText = verbLabel ? "${verbLabel} on ${intent.target}" : intent.target` (with focus-node/type-label fallback for flags); `intent.rationale` demoted to muted secondary text in the header (when non-empty) and the full "Why" detail tab. The structural action-line (`verb · target`) is replaced by a rationale line.

- 2026-06-25 — **About You redesigned into a full identity hub:** `Settings.tsx` — About You card rewritten into three stacked sections: (1) Identity: monogram badge (initials from `owner.name`, `User` icon fallback) + name input; (2) Connected Accounts: a structured row per `OWNER_SURFACES` entry with a surface abbreviation badge, handle input (editable only when connected), and a Verified/Confirm status pill; (3) Working Context: scope allowlists (formerly the standalone `ScopeCard` rendered via `WorkingContextSection`); (4) What mypa has learned: read-only graph-derived summary rendered by `LearnedProfileSection` — identifies owner person nodes by key pattern `${surface}:person:${handle}`, derives top containers (`Active in`) and collaborators (`Works with`) from graph edges, and shows top preference/pattern/hard memories (`Prefers`) via new `memory.getActive()` IPC. Standalone `ScopeCard` component and `<ScopeCard />` render site removed.

- 2026-06-22 — **Onboarding Step 2 rework — "Connect Claude":** `OnboardingWizard.tsx` step 2 rewritten. Old: hard gate on detecting the `claude` CLI binary (`detectClaudeBin`). New: calls `setup:check-prerequisites` (returns `{ ok, source: AuthSource }`) and shows which auth source is active. When no credentials are found, renders an inline API-key password input that saves via `api.config.setClaudeKey` and re-checks. Next button is a soft gate (enabled once auth is detected or a key is entered). Step 5 summary row is now dynamic: "Claude authenticated" (ok) or "Claude not authenticated" (not ok). Removed `cliOk`, `checkingCli`, `copied` state; added `authState`, `checkingAuth`, `apiKeyInput`, `savingKey`. Removed `copyInstallCommand`; added `handleSaveApiKey`. Imports: removed `Copy`, `ExternalLink`; added `KeyRound`, `AuthSource`.

- 2026-06-22 — **RoutineCard: collapsible tracked items + clickable tracked-item links.** The "Tracked items" section inside a routine card is now collapsed by default (shows only a toggle row: "Tracked items · N" + rotating chevron); the chat is visible first without scrolling. Clicking the toggle row expands/collapses the list. When a tracked entity has a URL (`CoveredEntity.url`), its title is rendered as a clickable link (cursor pointer, accent color on hover, inline `ExternalLink` icon) that calls `window.electron.system.openExternal(url)`. New CSS: `.routine-card__tracked-toggle`, `.routine-card__tracked-title--link`.

- 2026-06-22 — **IntentCard: clickable title + clickable Activity/Focus rows.** When an intent has a source URL (derived from `context_packet.focusNodes[].attrs.url` or `context_packet.recentSignals[].url`), the card title becomes a clickable link (`intent-card__title-link` span + inline `ExternalLink` icon) that opens the PR/issue in the default browser via `window.electron.system.openExternal`. Activity tab rows and Focus tab rows also become clickable links when their respective signal/node URL is non-empty. Clicking a title link does not toggle the card's expand state (stopPropagation). New CSS: `.intent-card__title-link`, `.intent-card__title-link-icon`, `.intent-detail__ctx-row--link`.

- 2026-06-22 — **Agent SDK migration — `InlineToolApproval` and `QuestionChip` in ChatThread:** `ChatThread.tsx` now handles two new push events from `agent.ts`. `chat:tool-approval-request` renders an `InlineToolApproval` block inline in the active message — shows tool name and arguments, Approve/Deny buttons, and an optional editable input for the payload; resolves via `window.electron.chat.resolveToolApproval`. `chat:ask-question` renders a `QuestionChip` cluster — shows the model's question and one chip per option; resolves via `window.electron.chat.answerQuestion`. Both components disappear once the stream resumes. Driven entirely by push events; no polling.

- 2026-06-18 — **IntentCard: restore primary action button.** `IntentCard.tsx:117` — `needsApproval` computation changed from `!isObservation && intent.required_approval && intent.tier >= 2` to `!isObservation && intent.tier >= 2`. The `intent.required_approval` term was silently hiding the Approve/Send button for action intents where the model emitted `required_approval=false` (e.g. tier-3 Locked intents that are user-initiated by definition). Any non-observation action at tier ≥ 2 now shows the primary button unconditionally — the model hint is advisory and should not gate user-facing controls. Comment added explaining the rationale. `agentWillHandle` (line 118) is unchanged: only tier 0/1 intents get the "agent will handle" chip.

- 2026-06-18 — **ChatThread: inline write-action proposal chips.** `ChatThread.tsx` gains two new optional props: `onApproveAction?: (message, editedPayload?) => Promise<void>` and `onDismissAction?: (message) => Promise<void>`. The `ChatBubble` now renders an `ActionChip` beneath the message text when `message.action` is present. `ActionChip` shows: (a) **pending** — label (e.g. "Github · Post comment"), editable draft textarea for `body`/`message` payload fields, and Approve (`Check`) / Dismiss (`X`) buttons; (b) **executed** — "Done · {resultText snippet}"; (c) **failed** — "Failed · {error}"; (d) **dismissed** — "Dismissed". `IntentCard.tsx` — `ChatThread` now receives `onApproveAction` and `onDismissAction` callbacks that call `api.ambient.approveChatAction` / `dismissChatAction`, then re-fetch the thread via `getChatThread`. New CSS classes: `.chat-action-chip`, `.chat-action-chip--pending/done/failed/dismissed`, `.chat-action-chip__label/target/draft/buttons/result`, `.btn--sm` (shared small button modifier). No emojis — Approve uses `Check` icon, Dismiss uses `X` icon (both `lucide-react`).

- 2026-06-17 — **Button trimming — merge Suggest into Chat:** `IntentCard.tsx` — removed Suggest button, Suggest panel, and all Suggest state/handlers (`suggesting`, `suggestThread`, `suggestStreaming`, `suggestError`, `handleSuggest`). Removed `Lightbulb` lucide import. Removed `&& !suggesting` guard from the action footer. Action footer is now `Dismiss · Chat · Challenge · [Approve]` (down from `Dismiss · Chat · Suggest · Challenge · [Approve]`). Inside the Chat panel, added an "Update the proposal" button (icon: `Wand2`) shown only for non-terminal action intents once the thread contains at least one assistant reply. Clicking it calls `api.ambient.reviseFromChat(intent.id)` → on success, updates the intent via `onIntentChange`, re-syncs `draftText`, and re-fetches the chat thread so the appended reply appears. Added `revising` boolean state for the button's loading state.

- 2026-06-17 — **IntentCard: "Chat about it" streaming thread.** `IntentCard.tsx` gains a "Chat" button (non-terminal intents) and "Chat about it" button (terminal/failed intents) that toggles a streaming `ChatThread` panel, keeping the existing "Suggest" non-streaming re-proposal panel separate. Chat state: `chatOpen`, `chatThread`, `chatStreaming`, `chatStreamContent`, `chatError`. Three effects wire the IPC: load thread on open (`ambient.getChatThread`), echo user messages (`ambient:chat-user-message`), and accumulate streaming chunks (`ambient:chat-message` — `done: true` triggers a thread re-fetch to replace the streaming content with persisted messages). `handleChatSend` → `ambient.sendChatMessage`; `handleChatStop` → `ambient.cancelChatStream`. Icon: `MessagesSquare` from `lucide-react`. The panel is available on all intent types and statuses so the user always has a discussion/recovery path even for failed actions.

- 2026-06-17 — **Insight↔routine run linkage UI (widget):** `App.tsx` — computes two memoized `Map`s from existing `intents` + `runs` state (no extra IPC calls): `entityKeyToIntent` (work-item key → most-recent `Intent`) and `entityKeyToRuns` (work-item key → `RoutineRun[]`). Both indexes are passed to `RoutinesFeed` (→ `RoutineCard`) and `QueueView` (→ `IntentCard`). `RoutineCard.tsx` — when a run has `covered_entities`, renders a **Tracked items** grid section above the `ChatThread`: each row shows a surface icon (`GitBranch`/`SquareKanban`/`MessageSquare`), the item title, and a live status badge derived from `entityKeyToIntent` ("Insight active" / "Handled" / "Dismissed" / "Expired" / "Tracked"). Status reacts live as intents update without extra IPC calls. `IntentCard.tsx` — for each focus node key that appears in `entityKeyToRuns`, renders a **"Also in: <routine_name>"** chip in the chip row (`Zap` icon). `QueueView.tsx` and `RoutinesFeed.tsx` — accept and forward the two index props. New `.routine-card__tracked*` CSS classes in `components.css`.

- 2026-06-17 — **Removed model selection controls (automatic model routing):** `Settings.tsx` — the Model `<select>` dropdown and its label removed from the "Claude AI" card; the card hint text updated to describe automatic model selection. `OnboardingWizard.tsx` — the "Choose a model" step 3 (`MODELS` constant, model state, save in `handleNext`, and the step UI block) removed; `Step` type narrowed from `1|2|3|4|5|6` to `1|2|3|4|5`; progress dots updated; old steps 4/5/6 renumbered to 3/4/5; the model summary row in the "All Set" screen replaced with "Model selection: automatic".

- 2026-06-17 — **IntentCard: fix draft textarea height + context sub-tabs:** `useAutoGrowTextarea.ts` made box-sizing-aware — reads actual border widths and detects `border-box`; under `border-box` `scrollHeight` is augmented by vertical borders before being clamped, fixing the last-line clip on `.intent-detail__draft`. `IntentCard.tsx` expanded-detail block reorganised: "Proposed action" always visible at the top; "Why this surfaced" and Context groups (Recent activity, Known facts, Focus) collapsed into a compact sub-tab bar below it — only tabs with data are rendered; active tab falls back to "Why" if data disappears. `Tabs.tsx` gains an optional `className` prop (non-breaking). `.intent-detail__tabs` CSS rule added in `components.css` for a smaller, card-appropriate tab row.

- 2026-06-16 — **InsightsPage: Activity tab + Poll now button:** `InsightsPage.tsx` gains a fourth **Activity** tab powered by `ambient.getLog(100)` — renders each `ActionLogEntry` as a compact timestamp / event / action_type / tier row; refreshes live on `ambient:action-executed`. A **Poll now** ghost button in the page header calls `ambient.pollNow()` with idle → "Polling…" → "Polled" state (`RefreshCw` / `CheckCircle` icons). Both backends were previously unreachable from any UI. `AmbientFeed.tsx` deleted (superseded by `QueueView`; was imported nowhere). Widget Ambient tab doc updated to reflect `QueueView` replacing `AmbientFeed`.

- 2026-06-16 — **Onboarding wizard error handling + cross-platform install hint:** `OnboardingWizard.tsx` — all async handlers (`handleFinish`, `handleNext`, `checkCli`, `handleAutoFillOwner`, `handleAddServer`, `handleCredentialSave`) upgraded from `try/finally` to `try/catch/finally`; each failure now shows a `toast.error()` so the user gets actionable feedback instead of a silent no-op. `handleFinish` in particular can no longer leave the user permanently stuck on the final screen. Initial `api.config.get()` effect also gains `.catch` + toast. Install hint for claude-not-found changed from macOS-only `brew install anthropic/claude/claude` to the cross-platform `npm install -g @anthropic-ai/claude-code`, usable on macOS, Linux, and Windows.
- 2026-06-15 — **Routines run-detail: Conversation tab first + action buttons:** `RunDetail` in `RunLogs.tsx` now defaults to the **Conversation** tab (was Raw output) and places it first in the tab bar. The Conversation tab gains **Dismiss** and **Mark resolved** buttons below the `ChatThread`, matching the widget's `RoutineCard` (minus the redundant "Open in main window" CTA). Status changes propagate back to the run row via a new `onRunChange` callback on `RunDetailProps`.
- 2026-06-13 — **"Needs you" inbox sub-tab in Routines:** `RoutinesPage.tsx` gains a third sub-tab ("Needs you", first tab, `Inbox` icon) that shows only `pending_response`/`in_progress` runs via `RunLogs` with a new `filterStatuses` prop; tab `count` prop is wired to `pendingCount` (= sidebar `routinesBadge`) so the badge drills precisely to the right spot. `RunLogs.tsx` gains optional `filterStatuses: RunStatus[]` and `emptyMessage: string` props (filtering is client-side at render time so open conversations are not collapsed when a run transitions status). `App.tsx`: `routinesTab` state widened to `RoutinesTab = 'needs' | 'routines' | 'logs'`; sidebar Routines click auto-lands on `'needs'` when `routinesBadge > 0`; completion toast action now navigates to `'needs'` ("View logs" label shortened to "View"); `navigate:run-chat` (OS notification click path) keeps pointing to `'logs'` so stale notifications for resolved runs still find the run. `RoutinesPage` exported `RoutinesTab` type imported into `App.tsx`.
- 2026-06-10 — **Scope card is now read-only + dynamic to enabled integrations:** `Settings.tsx` — `ScopeCard` rewritten. All manual add/remove inputs and X-button chips removed. Scope now self-derives from check-in conversations. Card renders one section per scope-capable surface (`SCOPE_SURFACES` from `src/shared/scope-surfaces.ts`) that is currently enabled (i.e. the integration's `integrationId` appears in `AppConfig.mcp_servers`). Each section shows read-only chips from `AppConfig.scope.allowed[surface]`; empty = "no restriction" hint. If no scope-capable integration is connected, a single informational hint is shown. `CheckInPage.tsx` — `scopeUpdated` count from `CheckInExtractionSummary` is now rendered in the post–check-in summary (both the inline badge and the `summaryLine` helper) so scope derivation is visible to the user.
- 2026-06-10 — **Scope card restyle + Danger Zone card:** `Settings.tsx` — `ScopeCard` now uses `.form-group`, `.form-label`, `.form-hint`, and `.form-input` classes (was broken: `className="input"` referenced an undefined CSS class; inline styles now replaced with shared design tokens). Removed unused `ScopeConfig` type import. Added `DangerZoneCard` component at the bottom of the Settings page with a two-step confirm-before-destroy factory reset button (`btn--danger`); calls `window.electron.system.factoryReset()`.
- 2026-06-10 — **Widget↔main parity, auto-grow inputs, status dot alignment, Suggest re-proposal:**
  - **Status dot alignment:** fixed `margin-top` on `.routine-card__dot` (components.css), `.run-log-row__status-dot` (index.css), and `StatusDot` inline style in `CheckInPage.tsx` so the 8px dot centers on the first title line at all title lengths.
  - **Auto-grow textareas:** new `src/renderer/src/hooks/useAutoGrowTextarea.ts` hook applied to `ChatThread`, `IntentCard` (draft + challenge), `PlanReviewCard` (detail), and `QuickAddBar` (converted from `<input>` to `<textarea>`). All grow from 1 row to a 4-row cap then scroll; shrink back on clear/send.
  - **Main-window parity:** `InsightsPage` gains a **Queue** tab (first tab, count badge) that reuses `QueueView` with `plan.getAll()` + `ambient.getIntents()`; all four actions (Approve/Dismiss/Challenge/Suggest) work in the main window. `App.tsx` computes per-page unread counts and shows `.nav-item__badge` pills on Insights and Routines sidebar items; badges update live via push events.
  - **Suggest re-proposal:** `IntentCard` gains a Suggest button that opens an embedded `ChatThread` (loaded via `ambient.getIntentThread`, sent via `ambient.suggest`); intent stays non-terminal across multiple Suggest rounds; `ambient:intent-message` push event drives live thread updates.
- 2026-06-09 — **Ambient Autonomy Show/Mute for informational intents:** `AmbientAutonomyCard` in `Settings.tsx` now shows the full 4-tier control only for `action` intents; `flag` and `digest` rows get a binary **Show / Mute** segmented control instead (Show → tier 1, Mute → tier 3). The dead `suggestion` row is removed (inference no longer emits that type). Muting suppresses informational intents in the backend before they are stored. Toast message updated to reflect Show/Mute labels for informational types.
- 2026-06-09 — **Phase C tab collapse (Queue + Routines):** widget collapsed from three tabs (`Routines | Plan | Ambient`) to two (`Queue | Routines`). New `QueueView.tsx` merges pending actionable intents ("Needs you" section) and active plan items (grouped by timing) into a single scrollable list; done/skipped plan items (including agent-executed `ambient_action` records) appear in a "Done" section. `TabStrip.tsx` updated: `Tab` type is now `'queue' | 'routines'`; activity dot moved to the Queue tab. `QuickAddBar` tab type updated to match; draft review card shows on the Queue tab. Widget default tab changed from `'routines'` to `'queue'`; push event `ambient:intent-created` now switches to the Queue tab instead of the old Ambient tab.
- 2026-06-09 — **Insights page + merged Routines/Run Logs:** renamed "Activity" nav tab to **Insights** (`InsightsPage.tsx`); daily `DigestView` is now always-on at the top of the page (with digest-type intents in a "Recent digests" section below it) instead of being hidden in a tab; two-tab strip below: Observations / History. Merged the separate "Run Logs" nav entry into the **Routines** page: new `RoutinesPage.tsx` wrapper owns the page header and a Routines / Run Logs `<Tabs>` strip; `RoutinesManager` and `RunLogs` are rendered as children with their own redundant page-header title/subtitle removed. Created reusable `components/Tabs.tsx` (replaces inline-styled tab bars) with `.tabs`/`.tab`/`.tab--active`/`.tab__count`/`.tab__count--active` CSS classes added to `components.css`. Updated `App.tsx`: `Page` union removes `'logs'` and renames `'activity'` → `'insights'`; `routinesTab` state propagated through `RoutinesPage`; `navigate:run-chat` and "View logs" toast action land on the Run Logs sub-tab; `navigate:edit-routine` lands on the Routines sub-tab.
- 2026-06-09 — **Activity tab: styled cards + Markdown prose:** extracted shared component CSS (`.routine-card*`, `.intent-card*`, `.intent-detail*`, `.intent-chip*`, `.plan-review-card*`, `.review-field*`, `.section-header/subheader`) from `widget/index.css` into a new `src/renderer/src/components.css` imported by both renderer entry points; this fixes the Activity tab (main window) where all card classes were previously undefined. Added `components/MarkdownText.tsx` shared component that renders prose through `ReactMarkdown` + `remark-gfm` + `md-text` styling; wired into `IntentCard` (rationale, payload quote, challenge reason), `DigestView` (did/watching items), and `ChatThread` (refactored to use the shared wrapper). Fixed undefined CSS vars in `ActivityPage.tsx` tab styles (`--text` → `--text-primary`, `--accent-dim` → `--accent-muted`, `--bg-raised` → `--bg-elevated`).
- 2026-06-09 — **action-centric ambient redesign (Phase A):** widget `AmbientFeed` now shows only `type:"action"` intents (observations/flags/digests removed from widget); cards with a drafted body (`payload.body`/`message`/etc.) auto-expand and render an editable `<textarea>` instead of a static quote; primary CTA on draft cards changed from "Approve" to "Send" and passes the edited payload to `ambient.approve(id, payload)`; widget `App.tsx` only switches to the ambient tab for action-type intents. Main-window gains a new **Activity** page (`components/ActivityPage.tsx`) with three tabs — Observations, Digests, History — powered by `ambient.getAllIntents()`; both `ambient:intent-created` and `ambient:intent-updated` push events now reach the main window via `broadcast()`.
- 2026-06-08 — `ChatThread` now uses a custom `markdownComponents` object passed to `<ReactMarkdown>` so that all `<a>` tags intercept clicks and call `window.electron.system.openExternal(href)` instead of navigating inside the webview; `PlanItemDetail` now listens for the `plan:item-updated` push event and updates its local `item.status` in real-time when the widget changes a plan item's status
- 2026-06-08 — added all chat CSS classes (`.chat-thread`, `.chat-message`, `.chat-message__bubble`, `.chat-input-row`, `.chat-input`, `.chat-send-btn`, `.chat-stop-btn`, `.typing-dot`, `.md-text` and variants) to `main-window/index.css`; `.chat-thread` max-height set to 480px (vs 240px in widget) and `.chat-message` font-size to 13px to match main-window type scale; fixes unstyled chat in `RunDetail` conversation tab and `PlanItemDetail`
- 2026-06-08 — `RunLogs` extended: expanded runs now have "Raw output" / "Conversation" tab toggle; `navigate:run-chat` auto-expands target run in conversation view; added `PlanItemDetail` component and `plan` page in main window; challenge reason now persisted to `Intent.challenge_reason` and rendered in IntentCard Recent view; inline challenge confirmation added to IntentCard; "Open full chat" button added to `PlanItemCard` and `RoutineCard` in widget
- 2026-06-07 — added `UsageDashboard` page (`components/UsageDashboard.tsx`); new `'usage'` nav item in `App.tsx`; added `.segmented`/`.segmented__btn`, `.stat-card`, `.breakdown-row`, `.usage-call-row`, `.usage-chart` CSS classes to `index.css`; no new dependencies
- 2026-06-07 — added unified toast notification system (`toast/ToastProvider.tsx`; `useToast()` hook); `App.tsx` now wraps `AppShell` in `<ToastProvider>` and runs `useRunToasts` bridge for routine run and ambient auto-exec events; `RoutinesManager`, `Settings`, `MemoryGraph` now toast on mutating action success/error
- 2026-06-07 — added "About You" card in Settings and step 5 in OnboardingWizard; both surface owner-identity fields (name + handles) with auto-fill from MCP
- 2026-06-07 — About You handle fields now filter to enabled MCP surfaces only; handle auto-resolved silently when a surface MCP is added (fires `setup.resolveOwnerHandles()` and merges into state; auto-fill button hidden when no identity surfaces are configured)
- 2026-06-07 — auto-fill result feedback moved from inline text to toast in both Settings and OnboardingWizard; handle fields now accept comma-separated values (e.g. "alice, alice-work") — `getOwnerHandles()` and `buildOwnerClause()` in `config.ts` split on commas at read time
- 2026-06-07 — `MemoryGraph` header: added Export button (calls `memory.exportMarkdown`); shows saving/saved/cancelled state with a 2.5 s reset
- 2026-06-06 — initial documentation
