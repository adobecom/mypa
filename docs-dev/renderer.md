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
main-window/App.tsx
  ├── Sidebar nav (4 items: Routines, Run Logs, Memory, Settings)
  ├── OnboardingWizard    — shown if onboarding_complete = false
  └── <page content>
```

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

Data: `window.electron.memory.getGraph()` on mount; `getNode(id)` on selection.

#### Settings

| Component | Description |
|---|---|
| `Settings` | Tabbed settings panel |
| — MCP tab | Add/edit/remove MCP servers; test connection; import from Claude Code config |
| — OAuth tab | Connect GitHub (device flow), Notion (PKCE), Linear (PKCE); show connection status |
| — Claude tab | Model selector; displays current model |
| — Preferences tab | Widget always-on-top, notification sound, launch on login; persona text field |

#### Onboarding wizard

`OnboardingWizard` walks first-time users through:
1. Installing / verifying the Claude CLI.
2. Connecting at least one MCP server.
3. (Optionally) connecting OAuth providers.
4. Setting preferences and persona.

Completes by setting `onboarding_complete: true` in config.

---

## Shared components

Located in `src/renderer/src/` (shared between widget and main window):

| Component | Description |
|---|---|
| `ChatThread` | Renders a `ChatMessage[]` history with a streaming-capable input box |
| `cronUtils.ts` | Human-readable cron expression parser (used in `RoutineForm`) |

## Changelog

- 2026-06-06 — initial documentation
