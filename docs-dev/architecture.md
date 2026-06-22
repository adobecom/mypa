# Architecture

mypa is a tray-based Electron app. It has three OS-level processes (main, two renderers) bridged by a preload script, plus a shared TypeScript layer.

## Process map

```
┌─────────────────────────────────────────────────────────────────┐
│  Main Process  (Node.js / Electron)                             │
│                                                                 │
│  src/main/index.ts      ← app entry (boot sequence below)      │
│  src/main/windows.ts    ← widget (380×580 frameless) + main    │
│  src/main/tray.ts       ← system-tray icon + badge count       │
│  src/main/ipc-handlers.ts ← ipcMain.handle() registrations     │
│  src/main/db/           ← better-sqlite3; schema + queries     │
│  src/main/services/     ← business logic (see services.md)     │
└─────────────┬───────────────────────────────────────────────────┘
              │  contextBridge
┌─────────────▼───────────────────────────────────────────────────┐
│  Preload  src/preload/index.ts                                  │
│  exposes window.electron : IpcApi via contextBridge             │
└─────────────┬───────────────────────────────────────────────────┘
              │  window.electron.<namespace>.<method>()
      ┌───────┴────────┐
      │                │
┌─────▼──────┐   ┌─────▼──────────────────────────────────────────┐
│  Widget    │   │  Main window                                    │
│  renderer  │   │  renderer                                       │
│            │   │                                                 │
│  widget    │   │  main-window.html                              │
│  .html     │   │  → src/renderer/src/main-window/               │
│  → widget/ │   │    App.tsx, RoutinesManager, MemoryGraph, …    │
└────────────┘   └────────────────────────────────────────────────┘
```

## Boot sequence (`src/main/index.ts`)

1. `initDb()` — opens/creates `~/.mypa/data.db`, runs `initSchema()`.
2. `ensureConfigDir()` — creates `~/.mypa/` if absent.
3. `createTray()` — installs the system-tray icon.
4. `connectAllServers()` — connects all enabled MCP servers from config.
5. `registerIpcHandlers(widgetWin, mainWin)` — sets up all `ipcMain.handle()` routes.
6. `startScheduler()` — loads enabled routines and schedules them with `node-cron`.
7. `startAmbientLoop()` — starts the background signal-polling timer.
8. Both renderer windows are created; the main window load is intentionally delayed 2 s in dev to avoid hitting Vite's cold-start burst.

## Data flow overview

```
External APIs (GitHub, Jira, Slack)
        │  OAuth tokens / MCP tools
        ▼
  ambient.ts / triggers.ts   ← periodic poll
        │
        ▼
  signals table (DB)
        │  ingestion.ts
        ▼
  graph_nodes / graph_edges / memories  (DB)
        │  inference.ts / memory-graph.ts
        ▼
  intents table (DB)
        │
        ├──► widget renderer  (ambient tab — IntentCard)
        └──► OS notification

User input (QuickAddBar)
        │  plan.ts → claude.ts → agent.ts
        ▼
  plan_items table (DB)  →  widget renderer (plan tab)

Scheduled routines (node-cron)
        │  routines.ts → mcp.ts → claude.ts → agent.ts
        ▼
  routine_runs table (DB)  →  widget renderer (routines tab) + OS notification
```

## Renderer windows

Two separate HTML entry points, each a React 18 SPA sharing the same preload:

| Window | Entry point | Size | Purpose |
|---|---|---|---|
| Widget | `src/renderer/widget.html` → `widget/App.tsx` | 380 × 580 px, frameless | Compact tray popover — always running, hidden until tray click |
| Main window | `src/renderer/main-window.html` → `main-window/App.tsx` | Resizable | Settings, routines management, memory graph |

## Shared layer (`src/shared/`)

| File | Role |
|---|---|
| `types.ts` | **Single source of truth** for all shared TypeScript types, the `IpcApi` interface, and `DEFAULT_CONFIG` |
| `mcp-catalog.ts` | Built-in MCP server catalog entries |
| `oauth-config.ts` | OAuth provider configurations (GitHub, Notion, Linear) |

## Path aliases

Configured in `electron.vite.config.ts` and `tsconfig.*.json`:

| Alias | Resolves to | Available in |
|---|---|---|
| `@shared` | `src/shared/` | main, preload, renderer |
| `@renderer` | `src/renderer/src/` | renderer only |

## IPC contract

`src/shared/types.ts` → `IpcApi` is the single contract. Adding a channel requires changes in three places:

1. **`src/shared/types.ts`** — add the method to `IpcApi`.
2. **`src/main/ipc-handlers.ts`** — implement with `ipcMain.handle('namespace:method', …)`.
3. **`src/preload/index.ts`** — expose via `contextBridge.exposeInMainWorld`.

See [ipc.md](ipc.md) for the full reference.

## Changelog

- 2026-06-22 — **Agent SDK migration:** updated data-flow diagram to show `claude.ts → agent.ts` in the routine and plan paths. `agent.ts` (`@anthropic-ai/claude-agent-sdk`) is now the actual AI entry point; `claude.ts` is a thin shim.

- 2026-06-07 — `src/main/windows.ts` gained `broadcast(channel, ...args)` — sends an IPC event to every open, non-destroyed window (widget + main); used by `routines.ts` and `ambient.ts` for events that should reach both windows
- 2026-06-06 — initial documentation
