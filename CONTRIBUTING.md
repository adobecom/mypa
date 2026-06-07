# Contributing to mypa

## Local setup

```bash
# 1. Clone and install dependencies
git clone https://github.com/adobecom/mypa.git
cd mypa
npm install

# 2. Rebuild native dependencies (better-sqlite3, onnxruntime-node)
npm run postinstall

# 3. Start in dev mode (Electron + Vite HMR)
npm run dev
```

> **Prerequisite:** [Claude Code CLI](https://claude.ai/code) must be installed and authenticated (`claude` must be on your `$PATH`). Node.js 20+ is required.

Run `npm run postinstall` any time you add or upgrade a native dependency.

There is no test suite. Manual verification is the primary method — run the app and exercise the changed feature.

---

## Branch & PR conventions

| Convention | Example |
|---|---|
| Feature branches | `feat/short-description` |
| Bug fix branches | `fix/short-description` |
| PRs target `main` | — |

Keep commits focused. Reference relevant issue numbers in the PR description.

---

## Documentation maintenance

> **Rule:** any code change that affects a documented area **must** update the matching doc(s) in the same PR, and add a dated entry to that doc's `## Changelog` section.

| When you change… | Update… |
|---|---|
| `src/shared/types.ts` — IpcApi, push channels | `docs-dev/ipc.md` |
| `src/main/db/schema.ts` — tables, columns, indexes | `docs-dev/database.md` |
| any file in `src/main/services/` | `docs-dev/services.md` + the relevant subsystem doc |
| knowledge-graph ontology (NodeType / EdgeRel in `types.ts`) | `docs-dev/knowledge-graph.md` |
| renderer pages or major components | `docs-dev/renderer.md` |
| new feature or subsystem | new doc (or expand existing) + update `docs-dev/README.md` index + update `README.md` Features list |

The same rule is enforced for AI agents in [CLAUDE.md](CLAUDE.md).

---

## Developer documentation

Full reference documentation lives in [`docs-dev/`](docs-dev/README.md):

- [Architecture](docs-dev/architecture.md) — process map, boot sequence, data flow
- [IPC reference](docs-dev/ipc.md) — all API namespaces and push-event channels
- [Database](docs-dev/database.md) — SQLite schema reference
- [Services](docs-dev/services.md) — main-process service modules
- [Knowledge graph](docs-dev/knowledge-graph.md) — ontology, decay, context assembly
- [Ambient intelligence](docs-dev/ambient-intelligence.md) — signals, intents, trust tiers
- [Claude integration](docs-dev/claude-integration.md) — how the app spawns the `claude` CLI
- [MCP & OAuth](docs-dev/mcp-and-oauth.md) — MCP client, built-in catalog, OAuth flows
- [Configuration](docs-dev/configuration.md) — config shape, secret encryption, build targets
- [Renderer](docs-dev/renderer.md) — UI map of both Electron windows

## Changelog

- 2026-06-06 — initial CONTRIBUTING.md
