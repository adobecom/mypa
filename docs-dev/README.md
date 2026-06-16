# mypa — Developer Documentation

This folder contains the full reference documentation for mypa contributors and AI agents working in this codebase. It complements the top-level [README](../README.md) and [CLAUDE.md](../CLAUDE.md), which cover the quick-start and AI-agent operating rules respectively.

## Contents

| Document | What it covers |
|---|---|
| [architecture.md](architecture.md) | Process boundaries, boot sequence, data-flow, path aliases |
| [ipc.md](ipc.md) | Full `IpcApi` reference — all namespaces, methods, and push-event channels |
| [database.md](database.md) | SQLite schema — all 13 tables, indexes, JSON columns, migration approach |
| [services.md](services.md) | All `src/main/services/` modules — key exports and responsibilities |
| [knowledge-graph.md](knowledge-graph.md) | Memory-graph ontology: 3 layers, 14 node types, 19 edge relations, decay, context assembly |
| [ambient-intelligence.md](ambient-intelligence.md) | Signals → intents pipeline, autonomy/trust tiers, digest cadence |
| [claude-integration.md](claude-integration.md) | How the app spawns the `claude` CLI — one-shot, streaming, cancellation |
| [mcp-and-oauth.md](mcp-and-oauth.md) | MCP client manager, built-in catalog, Claude-config import, OAuth flows |
| [configuration.md](configuration.md) | `~/.mypa/config.json` shape, secret encryption, DB location, build targets |
| [renderer.md](renderer.md) | UI map of both Electron windows and their React components |
| [dependencies.md](dependencies.md) | Transitive npm deprecation warnings — why they appear and why they cannot be safely removed |

## Documentation maintenance convention

> **Rule:** any code change that affects a documented area MUST update the matching doc(s) in the same commit, and add a dated entry to that doc's `## Changelog` section.

| When you change… | Update… |
|---|---|
| `src/shared/types.ts` — IpcApi, push channels | `ipc.md` |
| `src/main/db/schema.ts` — tables, columns, indexes | `database.md` |
| any file in `src/main/services/` | `services.md` + the relevant subsystem doc (`knowledge-graph.md`, `ambient-intelligence.md`, `claude-integration.md`, `mcp-and-oauth.md`) |
| knowledge-graph ontology (NodeType / EdgeRel) | `knowledge-graph.md` |
| renderer pages or major components | `renderer.md` |
| new feature or subsystem | a new doc (or expand an existing one) + update this index + update README Features list |

This table mirrors the rule in [CLAUDE.md](../CLAUDE.md#documentation-maintenance) so it is visible to both AI agents and human contributors.

## Changelog

- 2026-06-06 — initial documentation suite created
- 2026-06-16 — added dependencies.md documenting the six transitive npm deprecation warnings
