# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## First-time setup

Copy `.env.example` to `.env` and fill in credentials for the OAuth providers you need:

```bash
cp .env.example .env
```

Each provider requires its own OAuth app registration (callback URL: `mypa://oauth/callback`). See the comments in `src/shared/oauth-config.ts` for registration links. In CI or GitHub Actions, set the same variable names as repository secrets/environment variables instead of a `.env` file.

## Commands

```bash
npm run dev        # Start in dev mode (Electron + Vite HMR)
npm run build      # Compile TypeScript and bundle for production
npm run pack       # Package app into a directory (no installer)
npm run dist       # Build distributable installer (dmg/AppImage/nsis)
```

After changing native dependencies, rebuild them:
```bash
npm run postinstall   # Runs electron-rebuild for better-sqlite3
```

There are no test commands — the project has no test suite.

## Architecture

This is a **tray-based Electron app** with two renderer windows and a Node.js main process.

### Process boundaries

```
Main Process (Node.js)
  ├── src/main/index.ts          — app entry: boots DB, tray, MCP, cron, IPC
  ├── src/main/windows.ts        — widget (380×580, frameless) and main window
  ├── src/main/tray.ts           — system tray icon and badge count
  ├── src/main/ipc-handlers.ts   — all ipcMain.handle() registrations
  ├── src/main/db/               — better-sqlite3; schema + typed query functions
  └── src/main/services/
        claude.ts    — spawns `claude` CLI; handles one-shot and streaming JSON output
        mcp.ts       — MCP client connections (stdio) using @modelcontextprotocol/sdk
        cron.ts      — node-cron scheduler that fires routines
        routines.ts  — routine execution: MCP → Claude digest → OS notification
        plan.ts      — plan item creation and chat threads
        config.ts    — JSON config file read/write
        oauth.ts     — GitHub device flow + PKCE for Notion/Linear

Preload (src/preload/index.ts)
  — exposes window.electron (typed as IpcApi) via contextBridge

Renderer (React 18, two separate entry points)
  ├── src/renderer/widget.html        → src/renderer/src/widget/
  └── src/renderer/main-window.html  → src/renderer/src/main-window/

Shared (src/shared/)
  ├── types.ts         — all shared TypeScript types + IpcApi interface
  ├── mcp-catalog.ts   — built-in MCP server catalog
  └── oauth-config.ts  — OAuth provider configs
```

### IPC contract

`src/shared/types.ts` is the single source of truth for the IPC API shape (`IpcApi`). Any new IPC channel must be added there, implemented in `src/main/ipc-handlers.ts`, and exposed in `src/preload/index.ts`. Renderer code calls `window.electron.<namespace>.<method>()`.

Push events from main → renderer are sent with `widgetWin.webContents.send(channel, payload)` on channels: `routine:run-started`, `routine:run-completed`, `routine:run-message`, `plan:item-message`, `badge:updated`. The renderer subscribes via `window.electron.on(channel, fn)`.

### Claude integration

All AI calls go through `src/main/services/claude.ts` which **spawns the `claude` CLI** (Claude Code must be installed). Two modes:
- `runClaude()` — one-shot, `--output-format text`, parses JSON from stdout
- `runClaudeStream()` — streaming, `--output-format stream-json`, parses `assistant` event objects line-by-line; uses `\x00SPLIT\x00` sentinel to split multi-turn messages

The model is configured in `AppConfig.claude.model` (default `claude-opus-4-8`), read at call time via `readConfig()`.

### Database

SQLite via `better-sqlite3` (synchronous API). Schema is in `src/main/db/schema.ts` — tables: `routines`, `routine_runs`, `routine_run_threads`, `plan_items`, `plan_item_threads`, `plan_item_history`. JSON columns (`actions`, `digest`) are stored as TEXT and parsed in the query layer. No migrations — schema is applied with `CREATE TABLE IF NOT EXISTS` on startup.

### Two renderer windows

The widget (always running, hidden initially) and main-window (settings/routines management) share the same preload and IPC API but load different HTML entry points. In dev, Vite serves both; the main window load is intentionally delayed 2 s to avoid hitting Vite's cold-start burst.

### Path aliases

`@shared` → `src/shared/` (available in main, preload, and renderer)  
`@renderer` → `src/renderer/src/` (renderer only)
