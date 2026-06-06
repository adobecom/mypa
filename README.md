# mypa

A local-first personal assistant for developers, built as a macOS/Linux/Windows tray app. It runs routines on a schedule, surfaces AI-generated digests via desktop notifications, and keeps a plan list — all powered by the Claude CLI running on your machine.

## Features

- **Routines** — schedule recurring tasks that call MCP servers, run Claude prompts, and deliver digests as OS notifications
- **Plan** — capture and track plan items with AI-generated breakdowns and chat threads
- **Ambient feed** — a persistent widget showing live routine output and plan activity
- **Memory graph** — a knowledge graph of your project context, built from local embeddings
- **MCP integration** — connect to any MCP server (local stdio process) from a built-in catalog or custom config
- **OAuth integrations** — GitHub device flow, Notion PKCE, and Linear PKCE for enriching routines

## Prerequisites

- [Node.js](https://nodejs.org) 20+
- [Claude Code CLI](https://claude.ai/code) installed and authenticated (`claude` must be on your `$PATH`)

## Getting started

```bash
npm install
npm run dev          # Start Electron + Vite with hot-module reload
```

## Commands

| Command | Description |
|---|---|
| `npm run dev` | Start in dev mode (Electron + Vite HMR) |
| `npm run build` | Compile TypeScript and bundle for production |
| `npm run pack` | Package the app into a directory (no installer) |
| `npm run dist` | Build a distributable installer (dmg / AppImage / nsis) |
| `npm run postinstall` | Rebuild native deps (`better-sqlite3`) after install |

Run `npm run postinstall` any time you add or update a native dependency.

## Architecture

mypa is an Electron app with two renderer windows and a Node.js main process.

```
Main Process (Node.js)
  ├── src/main/index.ts          — app entry: boots DB, tray, MCP, cron, IPC
  ├── src/main/windows.ts        — widget (380×580, frameless) and main window
  ├── src/main/tray.ts           — system tray icon and badge count
  ├── src/main/ipc-handlers.ts   — all ipcMain.handle() registrations
  ├── src/main/db/               — better-sqlite3; schema + typed query functions
  └── src/main/services/
        claude.ts      — spawns `claude` CLI; one-shot and streaming JSON
        mcp.ts         — MCP client connections (stdio)
        cron.ts        — node-cron scheduler for routines
        routines.ts    — routine execution: MCP → Claude digest → notification
        plan.ts        — plan item creation and chat threads
        memories.ts    — local memory storage and retrieval
        memory-graph.ts — knowledge graph construction from embeddings
        embeddings.ts  — local embeddings via @xenova/transformers
        ingestion.ts   — content ingestion pipeline
        ambient.ts     — ambient feed event streaming
        autonomy.ts    — autonomous agent execution
        config.ts      — JSON config file read/write
        oauth.ts       — GitHub device flow + PKCE for Notion/Linear

Preload (src/preload/index.ts)
  — exposes window.electron (typed as IpcApi) via contextBridge

Renderer (React 18)
  ├── src/renderer/widget.html        → widget: ambient feed, plan list, routine cards
  └── src/renderer/main-window.html  → settings: routines manager, memory graph, onboarding

Shared (src/shared/)
  ├── types.ts         — all shared TypeScript types + IpcApi interface
  ├── mcp-catalog.ts   — built-in MCP server catalog
  └── oauth-config.ts  — OAuth provider configs
```

### IPC contract

`src/shared/types.ts` is the single source of truth for the IPC API shape (`IpcApi`). Any new channel must be added there, implemented in `src/main/ipc-handlers.ts`, and exposed in `src/preload/index.ts`. Renderer code calls `window.electron.<namespace>.<method>()`.

Push events from main → renderer travel on these channels: `routine:run-started`, `routine:run-completed`, `routine:run-message`, `plan:item-message`, `badge:updated`.

### Database

SQLite via `better-sqlite3` (synchronous API). Tables: `routines`, `routine_runs`, `routine_run_threads`, `plan_items`, `plan_item_threads`, `plan_item_history`. Schema lives in `src/main/db/schema.ts` and is applied with `CREATE TABLE IF NOT EXISTS` on startup — no migration tooling.

### Claude integration

All AI calls go through `src/main/services/claude.ts`, which spawns the `claude` CLI. Two modes:

- `runClaude()` — one-shot, `--output-format text`
- `runClaudeStream()` — streaming, `--output-format stream-json`, parses `assistant` event objects line-by-line

The model is read at call time from `AppConfig.claude.model` (default `claude-opus-4-8`).

## Configuration

The app stores its config as JSON (managed by `src/main/services/config.ts`). You can change the Claude model, MCP server connections, and OAuth tokens from the Settings panel inside the app.

## Tech stack

- [Electron](https://www.electronjs.org) 33
- [React](https://react.dev) 18
- [electron-vite](https://electron-vite.org) for dev/build tooling
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) for local storage
- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) for MCP client
- [@xenova/transformers](https://github.com/xenova/transformers.js) for local embeddings
- [node-cron](https://github.com/node-cron/node-cron) for scheduling
