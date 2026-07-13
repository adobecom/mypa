# mypa

**[🌐 Website](https://adobecom.github.io/mypa/)** · [GitHub](https://github.com/adobecom/mypa)

A local-first personal assistant for developers, built as a macOS/Linux/Windows tray app. It monitors your external surfaces (GitHub, Jira, Slack), builds a knowledge graph from what it observes, proposes actions for your review, and runs scheduled routines — all powered by the Claude Agent SDK running locally on your machine. Nothing leaves your device.

## Features

- **Routines** — schedule recurring tasks that call MCP servers, run Claude prompts, and deliver digests as OS notifications; set up routines from natural language
- **Plan** — capture and track plan items with AI-generated breakdowns, timing, and chat threads
- **Ambient intelligence** — background polling of GitHub, Jira, and Slack; the assistant proposes intents (actions, suggestions, flags) for you to approve or dismiss
- **Code authoring** — link a local git checkout to a GitHub repo / Jira project; when a ticket or PR is directed at you, mypa can attempt a real fix in an isolated git worktree, then present the diff for review with a one-tap "Ship it" (push + open PR + comment the ticket + notify Slack)
- **Autonomy / trust tiers** — per-action trust levels that adapt based on your approve/challenge/dismiss history; fully configurable and resettable
- **Memory graph** — a visual knowledge graph of people, work items, topics, and the assistant's own decisions, built from local embeddings; inspect and edit from the Memory page
- **Knowledge vault** — optionally ingest a local markdown vault (e.g. Obsidian), scoped to folders you choose, as read-only context; notes and `[[wikilinks]]` become graph nodes and edges alongside your observed work signals
- **Owner identity** — set your name and per-surface handles (GitHub, Slack, Jira, Linear, Notion) so the assistant addresses you as "you" rather than by handle; auto-fills from connected MCP servers with one click
- **Usage dashboard** — detailed token usage and estimated cost breakdown by feature, model, and time period; powered by data the Claude Agent SDK already reports
- **MCP integration** — connect to any MCP server (local stdio process) from a built-in catalog or custom config; auto-import from an existing Claude Code config
- **OAuth integrations** — GitHub device flow, Notion PKCE, and Linear PKCE for enriching routines with live data

## Prerequisites

- [Node.js](https://nodejs.org) 20+
- A way to authenticate Claude calls — mypa bundles the `@anthropic-ai/claude-agent-sdk`, so **no separate Claude Code CLI install is required**. Authentication resolves automatically, in priority order: a stored Anthropic API key (set in Settings), the `ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN` environment variables, or an existing `claude login` session.

  If you use CLI login as your auth source, mypa auto-detects `claude` in all common install locations — official installer (`~/.claude/local/claude`), Homebrew, nvm, npm-global, bun, volta — without requiring a manual PATH configuration.

## Getting started

```bash
git clone https://github.com/adobecom/mypa.git
cd mypa
npm install
npm run dev          # Start Electron + Vite with hot-module reload
```

## Install locally

To build and install mypa as a standalone desktop app (rather than running in dev mode):

```bash
git clone https://github.com/adobecom/mypa.git
cd mypa
npm install          # also rebuilds native deps (better-sqlite3) automatically
npm run dist         # compiles + packages; writes installer(s) to dist/
```

Then install the artifact for your platform:

**macOS** — open `dist/mypa-<version>.dmg` and drag mypa to Applications.

> Because the build is unsigned (`identity: null`), macOS Gatekeeper will block the first launch. Right-click the app in Applications, choose **Open**, then **Open** again in the dialog. Alternatively, clear the quarantine flag:
> ```bash
> xattr -dr com.apple.quarantine /Applications/mypa.app
> ```

**Linux** — run the AppImage directly:
```bash
chmod +x dist/mypa-<version>.AppImage
./dist/mypa-<version>.AppImage
```
Or install the Debian package: `sudo dpkg -i dist/mypa_<version>_amd64.deb`

**Windows** — run `dist\mypa Setup <version>.exe` and follow the installer.

Once launched, mypa lives in your system tray. See [Prerequisites](#prerequisites) above for how to authenticate Claude calls before the app can run AI features.

> **Quick local test (no installer):** `npm run pack` drops an unpacked app directory into `dist/` without producing an installer — useful for a fast smoke test after a local build.

## Troubleshooting

**`better-sqlite3` fails to compile during `npm install`**

This usually means the macOS Command Line Tools are missing or have a broken receipt. Fix:

```bash
sudo rm -rf /Library/Developer/CommandLineTools
xcode-select --install     # accept the popup; wait for it to finish
xcode-select -p            # should print /Library/Developer/CommandLineTools
npm install                # retry; the prebuilt binary should now download or compile
```

If the prebuilt download times out on a slow network, simply re-run `npm install` — it will retry. Once Command Line Tools are in place the source-compile fallback also succeeds.

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
  └── src/main/services/         — claude, mcp, cron, routines, plan, memory-graph,
                                   ambient, autonomy, embeddings, config, oauth, …

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

## Configuration

The app stores its config as JSON at `~/.mypa/config.json` (managed by `src/main/services/config.ts`). MCP server API keys and OAuth client secrets are encrypted at rest using Electron `safeStorage`. You can change the Claude model, MCP server connections, and OAuth tokens from the Settings panel inside the app.

## Tech stack

- [Electron](https://www.electronjs.org) 33
- [React](https://react.dev) 18
- [electron-vite](https://electron-vite.org) for dev/build tooling
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) for local storage
- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) for MCP client
- [@xenova/transformers](https://github.com/xenova/transformers.js) for local embeddings
- [node-cron](https://github.com/node-cron/node-cron) for scheduling

## 📚 Documentation

Full developer reference in [`docs-dev/`](docs-dev/README.md):

| Doc | Contents |
|---|---|
| [Architecture](docs-dev/architecture.md) | Process map, boot sequence, data flow |
| [IPC reference](docs-dev/ipc.md) | All API namespaces, methods, push channels |
| [Database](docs-dev/database.md) | SQLite schema — all 20 tables |
| [Services](docs-dev/services.md) | Main-process service modules |
| [Code authoring](docs-dev/code-authoring.md) | Repo links, isolated worktrees, the `author_fix` intent flow, and the ship pipeline |
| [Knowledge graph](docs-dev/knowledge-graph.md) | 14-node-type ontology, decay, context assembly |
| [Ambient intelligence](docs-dev/ambient-intelligence.md) | Signals → intents pipeline, trust tiers |
| [Claude integration](docs-dev/claude-integration.md) | How the app calls Claude via the Agent SDK (in-process, no CLI subprocess) |
| [MCP & OAuth](docs-dev/mcp-and-oauth.md) | MCP client, built-in catalog, OAuth flows |
| [Configuration](docs-dev/configuration.md) | Config shape, secret encryption, build targets |
| [Renderer](docs-dev/renderer.md) | UI map of both Electron windows |

See [CONTRIBUTING.md](CONTRIBUTING.md) to get started as a contributor.
