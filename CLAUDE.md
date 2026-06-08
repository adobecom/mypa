# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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

## UI conventions

**No emojis — ever.** Do not use emoji characters anywhere in the codebase: source files, UI text, comments, or documentation. The project uses `lucide-react` for all icons. When you need a visual indicator (empty states, status icons, decorative marks), choose an appropriate lucide icon (`import { IconName } from 'lucide-react'`) instead of an emoji.

## Documentation maintenance

> **Rule: any code change that affects a documented area MUST update the matching doc(s) in the same commit, and add a dated entry to that doc's `## Changelog` section.**

| When you change… | Update… |
|---|---|
| `src/shared/types.ts` — IpcApi interface, push channels | `docs-dev/ipc.md` |
| `src/main/db/schema.ts` — tables, columns, indexes | `docs-dev/database.md` |
| any file in `src/main/services/` | `docs-dev/services.md` + the relevant subsystem doc (`knowledge-graph.md`, `ambient-intelligence.md`, `claude-integration.md`, `mcp-and-oauth.md`) |
| knowledge-graph ontology (NodeType / EdgeRel in `types.ts`) | `docs-dev/knowledge-graph.md` |
| renderer pages or major components | `docs-dev/renderer.md` |
| new feature or subsystem | new doc (or expand an existing one) + update `docs-dev/README.md` index + update `README.md` Features list |

Full developer documentation: [`docs-dev/README.md`](docs-dev/README.md)

## Architecture

This is a **tray-based Electron app** with two renderer windows and a Node.js main process. For the detailed reference, see [`docs-dev/architecture.md`](docs-dev/architecture.md).

### Process boundaries

```
Main Process (Node.js)
  ├── src/main/index.ts          — app entry: boots DB, tray, MCP, cron, IPC
  ├── src/main/windows.ts        — widget (380×580, frameless) and main window
  ├── src/main/tray.ts           — system tray icon and badge count
  ├── src/main/ipc-handlers.ts   — all ipcMain.handle() registrations
  ├── src/main/db/               — better-sqlite3; schema + typed query functions
  └── src/main/services/
        claude.ts       — spawns `claude` CLI; one-shot and streaming
        mcp.ts          — MCP client connections (stdio)
        cron.ts         — node-cron scheduler for routines
        routines.ts     — routine execution: MCP → Claude digest → OS notification
        plan.ts         — plan item creation and chat threads
        config.ts       — JSON config file read/write (~/.mypa/config.json)
        oauth.ts        — GitHub device flow + PKCE for Notion/Linear
        ambient.ts      — background signal-polling loop
        autonomy.ts     — trust tier engine (approve/challenge/dismiss)
        triggers.ts     — trigger evaluators (spike/staleness/dependency/…)
        ingestion.ts    — signal ingestion pipeline
        inference.ts    — intent generation from context packets
        embeddings.ts   — local embeddings via @xenova/transformers
        memories.ts     — memory CRUD
        memory-graph.ts — knowledge graph construction and decay
        claude-import.ts — auto-detect MCP servers from Claude Code config

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

IPC namespaces: `plan`, `routines`, `config`, `oauth`, `setup`, `system`, `ambient`, `memory`. Push event channels include `routine:run-*`, `plan:item-message`, `badge:updated`, `navigate:edit-routine`, `ambient:*`. Full reference: [`docs-dev/ipc.md`](docs-dev/ipc.md).

### Claude integration

All AI calls go through `src/main/services/claude.ts` which **spawns the `claude` CLI** (Claude Code must be installed). Two modes:
- `runClaude()` — one-shot, `--output-format text`
- `streamChat()` — streaming, `--output-format stream-json`; uses `\x00SPLIT\x00` sentinel to split multi-block responses

The model is configured in `AppConfig.claude.model` (default `claude-opus-4-8`), read at call time via `readConfig()`. See [`docs-dev/claude-integration.md`](docs-dev/claude-integration.md).

### Database

SQLite via `better-sqlite3` (synchronous API). Schema is in `src/main/db/schema.ts` — 13 tables covering routines, plan items, ambient signals, knowledge graph, intents, and memories. JSON columns stored as TEXT and parsed in the query layer. Schema is applied with `CREATE TABLE IF NOT EXISTS` on startup; additive migrations use `ALTER TABLE` in a try/catch. See [`docs-dev/database.md`](docs-dev/database.md).

### Knowledge graph

A 3-layer graph (observed world / semantic / assistant cognition) with 14 node types and 19 edge relations, built from external signals and mypa's own actions. Hourly decay, similarity edges via local embeddings, and a context-packet assembly pipeline for inference. See [`docs-dev/knowledge-graph.md`](docs-dev/knowledge-graph.md).

### Two renderer windows

The widget (always running, hidden initially) and main-window (settings/routines/memory management) share the same preload and IPC API but load different HTML entry points. In dev, Vite serves both; the main window load is intentionally delayed 2 s to avoid hitting Vite's cold-start burst. See [`docs-dev/renderer.md`](docs-dev/renderer.md).

### Path aliases

`@shared` → `src/shared/` (available in main, preload, and renderer)  
`@renderer` → `src/renderer/src/` (renderer only)

### Runtime data

- Config: `~/.mypa/config.json` — MCP env vars and OAuth client secrets encrypted with Electron `safeStorage` (`enc:` prefix)
- Database: `~/.mypa/data.db` (WAL mode)
