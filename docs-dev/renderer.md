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
| `IntentCard` | Single intent — rationale, proposed action, confidence badge, Approve / Dismiss / Challenge controls |

Data flow: `window.electron.ambient.getIntents()` + `getDigest()` on mount; push events `ambient:intent-created`, `ambient:intent-updated`, `ambient:tray-state`, `ambient:digest-ready`.

### QuickAddBar

Free-text input at the bottom of the widget. Calls `window.electron.plan.createDraft(intent)` → shows `PlanReviewCard` for confirmation → `window.electron.plan.confirm(draft)` to persist.

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
  │     ├── Sidebar nav (5 items: Routines, Run Logs, Memory, Usage, Settings)
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
Toasts support an optional `action: { label, onClick }` button (e.g. "View logs" that navigates to Run Logs).

**Background-event bridge** (`useRunToasts` in `App.tsx`): subscribes to `routine:run-started` (→ loading toast), `routine:run-completed` (→ update to success/error; "View logs" action button), and `ambient:action-executed` (→ info toast). This is why clicking **Run now** in RoutinesManager now shows visible feedback — the run events are broadcast to both windows (see IPC docs).

Styles in `src/renderer/src/main-window/index.css` (`.toast*` block), using existing design tokens. Timer cleanup on unmount prevents leaks.

### Pages

#### Routines

| Component | Description |
|---|---|
| `RoutinesManager` | List of all saved routines with enable/disable toggle and run-now button |
| `RoutineForm` | Create / edit a routine: name, cron expression (with human-readable preview via `cronUtils.ts`), MCP actions, digest prompt |
| `ServerCatalogPicker` | Browse and add servers from the built-in MCP catalog |

Navigating here with a `routineId` (via `navigate:edit-routine` push event) opens the `RoutineForm` in edit mode for that routine.

#### Run Logs

| Component | Description |
|---|---|
| `RunLogs` | Paginated table of all routine runs across all routines; click a row to expand the digest and thread |

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

## Changelog

- 2026-06-07 — added `UsageDashboard` page (`components/UsageDashboard.tsx`); new `'usage'` nav item in `App.tsx`; added `.segmented`/`.segmented__btn`, `.stat-card`, `.breakdown-row`, `.usage-call-row`, `.usage-chart` CSS classes to `index.css`; no new dependencies
- 2026-06-07 — added unified toast notification system (`toast/ToastProvider.tsx`; `useToast()` hook); `App.tsx` now wraps `AppShell` in `<ToastProvider>` and runs `useRunToasts` bridge for routine run and ambient auto-exec events; `RoutinesManager`, `Settings`, `MemoryGraph` now toast on mutating action success/error
- 2026-06-07 — added "About You" card in Settings and step 5 in OnboardingWizard; both surface owner-identity fields (name + handles) with auto-fill from MCP
- 2026-06-07 — About You handle fields now filter to enabled MCP surfaces only; handle auto-resolved silently when a surface MCP is added (fires `setup.resolveOwnerHandles()` and merges into state; auto-fill button hidden when no identity surfaces are configured)
- 2026-06-07 — auto-fill result feedback moved from inline text to toast in both Settings and OnboardingWizard; handle fields now accept comma-separated values (e.g. "alice, alice-work") — `getOwnerHandles()` and `buildOwnerClause()` in `config.ts` split on commas at read time
- 2026-06-07 — `MemoryGraph` header: added Export button (calls `memory.exportMarkdown`); shows saving/saved/cancelled state with a 2.5 s reset
- 2026-06-06 — initial documentation
