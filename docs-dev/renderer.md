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
| `AmbientFeed` | Scrollable list of pending/surfaced intents |
| `IntentCard` | Single intent — rationale, proposed action, confidence badge, Approve / Dismiss / Challenge / Suggest controls; Suggest opens an embedded `ChatThread` for multi-round re-proposal |

Data flow: `window.electron.ambient.getIntents()` + `getDigest()` on mount; push events `ambient:intent-created`, `ambient:intent-updated`, `ambient:intent-message`, `ambient:tray-state`, `ambient:digest-ready`.

### QuickAddBar

Free-text `<textarea>` at the bottom of the widget (converted from `<input type="text">`). Auto-grows 1–4 rows via `useAutoGrowTextarea`. Calls `window.electron.plan.createDraft(intent)` → shows `PlanReviewCard` for confirmation → `window.electron.plan.confirm(draft)` to persist. Enter submits; Shift+Enter inserts a newline.

### Shared hooks

`src/renderer/src/hooks/useAutoGrowTextarea(value, maxRows = 4)` — ref-based textarea auto-grow hook. On every `value` change: resets `height='auto'`, reads `scrollHeight`, clamps to `maxRows` lines (computed from `lineHeight` + padding), sets `overflow-y: auto` when content overflows the cap, `hidden` otherwise. Applied to: `ChatThread` chat input, `IntentCard` draft and challenge textareas, `PlanReviewCard` detail textarea, and `QuickAddBar`.

### Sidebar unread badges

`main-window/App.tsx` computes per-page unread counts on mount and via push events (`ambient:intent-created`, `ambient:intent-updated`, `plan:item-updated`, `badge:updated`):
- **Insights** — pending action intents + active (non-done/skipped) plan items.
- **Routines** — `pending_response` routine runs.

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
Toasts support an optional `action: { label, onClick }` button (e.g. "View logs" that navigates to the Run Logs sub-tab of the Routines page).

**Background-event bridge** (`useRunToasts` in `App.tsx`): subscribes to `routine:run-started` (→ loading toast), `routine:run-completed` (→ update to success/error; "View logs" action switches to the Run Logs sub-tab), and `ambient:action-executed` (→ info toast). This is why clicking **Run now** in RoutinesManager now shows visible feedback — the run events are broadcast to both windows (see IPC docs).

Styles in `src/renderer/src/main-window/index.css` (`.toast*` block), using existing design tokens. Timer cleanup on unmount prevents leaks.

### Pages

#### Routines

`RoutinesPage` is the nav-level wrapper; it owns the page header and the **Routines / Run Logs** tab strip. The active tab renders one of its two children:

| Component | Description |
|---|---|
| `RoutinesPage` | Outer shell: page header ("Routines"), Routines/Run Logs `<Tabs>` strip, conditionally renders child |
| `RoutinesManager` | List of all saved routines with enable/disable toggle and run-now button; "+ New routine" action row at top |
| `RoutineForm` | Create / edit a routine: name, cron expression (with human-readable preview via `cronUtils.ts`), MCP actions, digest prompt |
| `ServerCatalogPicker` | Browse and add servers from the built-in MCP catalog |
| `RunLogs` | Table of all routine runs; click a row to expand; expanded view has "Raw output" / "Conversation" toggle |

`navigate:edit-routine` → opens the Routines sub-tab and opens `RoutineForm` in edit mode.  
`navigate:run-chat` → opens the Run Logs sub-tab and auto-expands the target run in conversation view.  
"View logs" toast action → navigates to the Run Logs sub-tab.

#### Insights

`InsightsPage` surfaces the agent's ambient intelligence in a structured layout:

1. **Queue tab (first):** reuses the widget's `QueueView` component to render the full actionable queue — pending `action`-type intents ("Needs you") and active plan items — with working Approve / Dismiss / Challenge / Suggest actions. A count badge on the Queue tab reflects `pendingActionIntents + activePlanItems`. Plan items are fetched via `plan.getAll()` and kept live via `plan:item-updated` and `badge:updated` push events.
2. **Daily Digest (always on in Observations):** `DigestView` sits at the top of the Observations tab, always visible, with its morning / midday / end-of-day slot selector. Any non-terminal `digest`-type intents are listed directly below it under "Recent digests".
3. **History tab:** full history of terminal intents (executed, dismissed, challenged, failed, expired).

| Component | Description |
|---|---|
| `InsightsPage` | Outer shell: page header ("Insights"), Queue / Observations / History `<Tabs>` strip |
| `QueueView` | Shared widget+main component: "Needs you" action intents + active plan items + Done section; supports all four intent actions including Suggest |
| `DigestView` | Self-contained: fetches and renders the `AmbientDigest` for the selected slot; has its own slot selector and re-fetches on `ambient:digest-ready` |
| `IntentCard` | Single intent card with Approve / Dismiss / Challenge / Suggest actions; shared with widget |

Data flow: `window.electron.ambient.getAllIntents(200)` + `window.electron.plan.getAll()` on mount; `ambient:intent-created`, `ambient:intent-updated`, `plan:item-updated`, `badge:updated` push events for live updates; `ambient:digest-ready` handled inside `DigestView`.

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
