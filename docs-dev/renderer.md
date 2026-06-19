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

Data flow: `window.electron.ambient.getIntents()` + `getDigest()` on mount; push events `ambient:intent-created`, `ambient:intent-updated`, `ambient:tray-state`, `ambient:digest-ready`, `ambient:chat-user-message`, `ambient:chat-message`.

### QuickAddBar

Free-text `<textarea>` at the bottom of the widget (converted from `<input type="text">`). Auto-grows 1–4 rows via `useAutoGrowTextarea`. Calls `window.electron.plan.createDraft(intent)` → shows `PlanReviewCard` for confirmation → `window.electron.plan.confirm(draft)` to persist. Enter submits; Shift+Enter inserts a newline.

### Shared hooks

`src/renderer/src/hooks/useAutoGrowTextarea(value, maxRows = 4)` — ref-based textarea auto-grow hook. On every `value` change: resets `height='auto'`, reads `scrollHeight`, clamps to `maxRows` lines (computed from `lineHeight` + padding), sets `overflow-y: auto` when content overflows the cap, `hidden` otherwise. Applied to: `ChatThread` chat input, `IntentCard` draft and challenge textareas, `PlanReviewCard` detail textarea, and `QuickAddBar`.

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
| `ServerCatalogPicker` | Browse and add servers from the built-in MCP catalog |
| `RunLogs` | Table of routine runs; click a row to expand; expanded view has "Conversation" (default) / "Raw output" toggle; Conversation tab shows **Dismiss** / **Mark resolved** action buttons; optional `filterStatuses` and `emptyMessage` props |

Navigation:
- Clicking **Routines** in the sidebar → auto-opens **Needs you** if `routinesBadge > 0`, otherwise lands on **Routines** tab.
- `navigate:edit-routine` → opens the Routines sub-tab and opens `RoutineForm` in edit mode.  
- `navigate:run-chat` → opens the Run Logs sub-tab and auto-expands the target run in conversation view (uses 'logs' so that resolved/dismissed runs from stale notifications are still reachable).  
- "View" toast action → navigates to the Needs you sub-tab.

#### Insights

`InsightsPage` surfaces the agent's ambient intelligence in a structured layout:

1. **Queue tab (first):** reuses the widget's `QueueView` component to render the full actionable queue — pending `action`-type intents ("Needs you") and active plan items — with working Approve / Dismiss / Challenge / Chat actions. A count badge on the Queue tab reflects `pendingActionIntents + activePlanItems`. Plan items are fetched via `plan.getAll()` and kept live via `plan:item-updated` and `badge:updated` push events.
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

Data flow: `window.electron.ambient.getAllIntents(200)` + `window.electron.plan.getAll()` + `window.electron.ambient.getLog(100)` on mount; `ambient:intent-created`, `ambient:intent-updated`, `plan:item-updated`, `badge:updated`, `ambient:action-executed` push events for live updates; `ambient:digest-ready` handled inside `DigestView`.

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
| `Settings` | Tabbed settings panel |
| — MCP tab | Add/edit/remove MCP servers; test connection; import from Claude Code config |
| — OAuth tab | Connect GitHub (device flow), Notion (PKCE), Linear (PKCE); show connection status |
| — Claude tab | Model selector; displays current model |
| — Preferences tab | Widget always-on-top, notification sound, launch on login; persona text field |
| — About You card | Owner identity: name + per-surface handles; handle fields are filtered to enabled MCP surfaces only (no fields shown for surfaces the user hasn't configured); when a new surface MCP is added, `setup.resolveOwnerHandles()` fires automatically and pre-fills the handle if found, with ✓ / ⚠ markers |

#### Onboarding wizard

`OnboardingWizard` walks first-time users through (6 steps):
1. Welcome.
2. Installing / verifying the Claude CLI.
3. Choosing a model.
4. Connecting MCP servers / OAuth providers.
5. **About you** — name + per-surface handles with auto-fill button; saves to `AppConfig.owner`.
6. All set — summary.

Completes by setting `onboarding_complete: true` in config.

---

## Shared components

Located in `src/renderer/src/` (shared between widget and main window):

| Component | Description |
|---|---|
| `ChatThread` | Renders a `ChatMessage[]` history with a streaming-capable input box |
| `cronUtils.ts` | Human-readable cron expression parser (used in `RoutineForm`) |
| `components/MarkdownText.tsx` | Renders a markdown string via `ReactMarkdown` + `remark-gfm` wrapped in `<div className="md-text">`. Handles external link clicks via `window.electron.system.openExternal`. Used in `IntentCard`, `DigestView`, and `ChatThread`. |
| `components/Tabs.tsx` | Reusable underline-tab strip. Props: `items: TabItem[]`, `active: string`, `onChange: (id: string) => void`. `TabItem` has `id`, `label`, optional `icon` and `count`. Active tab gets accent underline + bold; count shows a colored pill. CSS classes: `.tabs`, `.tab`, `.tab--active`, `.tab__count`, `.tab__count--active` (in `components.css`). |
| `components.css` | Shared component stylesheet imported by both renderer entry points before their window-specific `index.css`. Contains `.routine-card*`, `.intent-card*`, `.intent-detail*`, `.intent-chip*`, `.plan-review-card*`, `.review-field*`, `.section-header`, `.section-subheader`, `.tabs`, `.tab*`. |

## Changelog

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
