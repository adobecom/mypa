# Knowledge Graph

mypa builds a persistent knowledge graph from external signals (GitHub, Jira, Slack) and its own actions — plus, optionally, a local markdown knowledge vault (e.g. Obsidian). The graph is visible in the Memory page of the main window (`MemoryGraph.tsx`).

**Source files:**
- Ontology types: `src/shared/types.ts` — `NodeType`, `EdgeRel`
- Graph construction: `src/main/services/memory-graph.ts`
- DB schema: `src/main/db/schema.ts` — `graph_nodes`, `graph_edges`, `node_signals`
- IPC: `memory` namespace in `src/shared/types.ts` (vault config via `config`; folder listing via `knowledge` namespace)
- Renderer: `src/renderer/src/main-window/components/MemoryGraph.tsx`
- Obsidian vault adapter: `src/main/services/ingestion.ts` — `makeObsidianAdapter()`

---

## Ontology

The graph has three layers. Nodes in higher layers reference nodes in lower layers via "cognition bridge" edges.

### Layer 1 — Observed world (from signals)

| NodeType | Key pattern | Created by |
|---|---|---|
| `person` | `{surface}:person:{username}` | Signal actor / assignee / @mention |
| `repo` | `github:{owner}/{repo}` | GitHub signal container |
| `project` | `jira:{projectKey}` | Jira signal container |
| `channel` | `slack:channel:{channelId}` | Slack signal container |
| `sprint` | `jira:sprint:{sprintId}` | Jira sprint field in raw payload |
| `pull_request` | `{surface}:pull_request:{id}` | Signal kind = `pull_request` |
| `issue` | `{surface}:issue:{id}` | Signal kind = `issue` |
| `message` | `slack:message:{ts}` | Signal kind = `message` |
| `document` | `obsidian:note:{vault-relative-path}` (notes) or `obsidian:folder:{folder}` (containers) | Signal kind = `note`, from the Obsidian vault adapter |

### Layer 2 — Semantic

| NodeType | Created by |
|---|---|
| `topic` | `buildSimilarityEdges()` clusters top-12 node labels by cosine similarity |

### Layer 3 — Assistant cognition

Written by mypa when it takes or plans action. These bridge into the observed world via cognition-bridge edges.

| NodeType | Key pattern | Created by |
|---|---|---|
| `decision` | `decision:{uuid}` | `autonomy.ts` when an intent is executed |
| `intent` | `intent:{id}` | `routines.ts` / `plan.ts` at creation |
| `routine` | `routine:{id}` | `routines.ts` when a routine runs |
| `plan_item` | `plan_item:{id}` | `plan.ts → confirmPlanDraft()` |

---

## Edge relations (`EdgeRel`)

### Participation (person ↔ work item)

| Relation | Meaning |
|---|---|
| `authored` | Person created the work item |
| `reviews` | Person is a reviewer on the PR |
| `assigned_to` | Person is assigned to the issue/PR |
| `mentioned_in` | Person was @mentioned in the body |
| `participates_in` | Person commented or otherwise engaged |

### Structure (containment)

| Relation | Meaning |
|---|---|
| `part_of` | Work item belongs to a repo/project/channel/sprint |

### Dependency

| Relation | Meaning |
|---|---|
| `blocked_by` | This item is blocked by another |
| `depends_on` | Explicit dependency relationship |
| `waiting_for` | Waiting on another person or item |
| `relates_to` | General relationship link |
| `references` | One item references another (e.g. a PR closing an issue, or a vault note's `[[wikilink]]`) |

### Semantic

| Relation | Meaning |
|---|---|
| `about` | A topic node is about a content node (Layer 2 → Layer 1) |
| `similar_to` | Two nodes with high embedding cosine similarity |

### Cognition bridges (Layer 3 → Layers 1–2)

| Relation | Meaning |
|---|---|
| `targets` | An intent/plan_item targets a specific work item |
| `addresses` | A decision/plan_item addresses an issue or PR |
| `produced` | A routine produced a decision or intent |
| `concerns` | A decision/intent concerns a person or topic |
| `deferred` | An intent was deferred in favour of another node |

---

## Signal ingestion (`ingestSignalIntoGraph`)

Called from `ingestion.ts` for each unprocessed signal. Steps per signal:

1. **Work-item node** — upsert `(kind → NodeType, surface:kind:external_id)`, bump weight by 1.0, link to `node_signals` timeline.
2. **Container node** — upsert the repo / project / channel; bump weight by 0.5; add `part_of` edge.
3. **Sprint node** (Jira only) — upsert from `raw.fields.sprint`; add `part_of` edge.
4. **Person node (actor)** — upsert, bump weight by 0.3; add role-aware participation edge (`authored` / `reviews` / `participates_in`).
5. **Assignee edges** — parse raw payload for `assignees` or `assignee` fields; add `assigned_to` edges.
6. **@mention edges** — regex-scan `body` for `@username` patterns; add `mentioned_in` edges.
7. **Dependency edges** — parse raw payload for Jira `blockedBy` / `issueLinks`; add `blocked_by` / `depends_on` edges.
8. **Wikilink edges** (`obsidian` signals only) — resolve `raw.wikilinks` (vault-relative paths pre-resolved by the adapter) to their `document` nodes; add `references` edges (`deriveWikilinkEdges`).

---

## Knowledge vault (Obsidian)

A local markdown vault can be ingested as a **read-only context layer** — the user's own curated notes, distinct from observed work signals. Configured in Settings → Knowledge Vault (`AppConfig.knowledge.vault: { path, folders, enabled }`), scoped to user-selected subfolders so a personal vault's non-work notes can be excluded.

**Source:** `makeObsidianAdapter()` in `src/main/services/ingestion.ts`. Unlike the other adapters it reads the filesystem directly (no MCP server) — `poll()` walks the selected folders for `.md` files, strips YAML frontmatter (capturing `tags`), extracts the first H1 (or filename) as the title, and resolves `[[wikilink]]` target names against a full vault-relative note-name index built from the same walk. One signal per note (`kind: 'note'`, `surface: 'obsidian'`); the fingerprint combines a content hash (not mtime, which Obsidian rewrites on every vault re-index) **and** the note's resolved `wikilinks` list — a note re-processes when either its own text changes, or when a previously-unresolvable `[[link]]` becomes resolvable (its target note now exists) or a resolved one becomes broken. Without the latter, a note whose `[[link]]` target didn't exist yet at ingest time would never gain that edge later, since an untouched note's content hash alone never changes.

**Role in the graph:**
- Each note becomes a `document` node (`obsidian:note:{path}`); each note's folder becomes a `document` container node (`obsidian:folder:{folder}`) linked `part_of`.
- `[[wikilinks]]` become `references` edges — human-authored structure, distinct from the inferred `similar_to` edges.
- Notes are embedded like any other signal, so they surface automatically in `assembleContextPacket`'s `semanticSignals` (see below) whenever relevant to a GitHub/Jira item — no special-casing needed there.

**Deliberately excluded from proactive behavior:** vault signals have no `actor`/`relation`/`directed` (there's no "actor" for a note, and nothing is ever directed at the owner by a note), so they never satisfy `evalWaitingOnMe`/`evalDependency`. `evalSpike` fires on raw signal volume regardless of relation, so `ambient.ts`'s `onNewSignals`/`ambientPollNow` explicitly filter obsidian signals out before trigger evaluation — a bulk vault import or a flurry of note edits must never look like a spike. `'obsidian'` is also intentionally omitted from `VALID_SURFACES` in `inference.ts`, so it can never be a proposed-action target, and from the `runMemorySummarization` surface list in `memories.ts` (notes are already human-distilled; no need to re-summarize them into memories).

**Forward references (same-batch and cross-poll):** a note may `[[link]]` to a note that hasn't been ingested yet. Within a single poll batch (e.g. the initial bulk import), `ingestSignalIntoGraph` resolves wikilinks inline as it processes each signal, then `ambient.ts`'s shared `ingestSignalsAndResolveWikilinks` helper re-runs `deriveWikilinkEdges` in a second pass over the whole batch once every note's `document` node exists, resolving same-batch forward references. `deriveWikilinkEdges` is idempotent (checks existing edges first), so this second pass is a no-op for links already resolved. Across separate poll cycles (the far more common case — writing a note today that links to a page you create tomorrow), the fingerprint's `wikilinks` component (see above) is what makes this work: once the target exists, the source note's fingerprint changes on the next poll even though its own text didn't, so it re-enters the batch and its wikilinks get re-resolved.

---

## Similarity edges (`buildSimilarityEdges`)

Runs on an hourly timer. Steps:

1. Fetch the top-12 nodes by weight from `graph_nodes`.
2. Embed each node's `label` using `embeddings.ts` (on-device, `@huggingface/transformers` / transformers.js v3).
3. Compute pairwise cosine similarity.
4. For any pair with similarity ≥ **0.82**, upsert a `similar_to` edge.

---

## Weight decay (`applyDecay`)

Runs hourly. Decay is multiplicative (half-life configured via `AmbientConfig.decayHalfLifeDays`, default 7 days):

```
new_weight = weight × (0.5 ^ (1 / (halfLifeDays × 24)))
```

Nodes and edges below a floor weight (0.01) are candidates for pruning by `dbRunMaintenance()`.

---

## Context assembly

When the inference engine needs to evaluate triggers, `assembleContextPacket(triggerKind)` builds a `ContextPacket`:

```ts
interface ContextPacket {
  triggerKind:     TriggerKind
  focusNodes:      GraphNode[]    // nodes most relevant to the trigger
  relatedEdges:    GraphEdge[]    // edges connecting focus nodes
  recentSignals:   Signal[]       // raw signals from the last poll window
  topByWeight:     GraphNode[]    // global top-N nodes by weight
  semanticSignals: Signal[]       // signals with similar embeddings
  memories:        Memory[]       // active memories for focus nodes
}
```

`renderPacketForPrompt(packet)` serializes this to a compact, prompt-ready string that Claude receives as context when generating intents and digests.

---

## IPC (`memory` namespace)

| Method | Description |
|---|---|
| `getGraph()` | Full `{ nodes, edges }` snapshot |
| `getNode(id)` | Node + its edges + memories + `node_signals` timeline |
| `deleteNode(id)` | Cascade delete |
| `deleteEdge(id)` | Single edge delete |
| `deleteMemory(id)` | Single memory delete |
| `updateMemory(id, patch)` | Edit content, importance, or supersede a memory |

---

## Renderer (`MemoryGraph.tsx`)

Renders the graph as a force-directed canvas using `react-force-graph-2d`. Node size is proportional to `weight`. Clicking a node opens `NodeDetailPanel` which shows its type, label, edges, memories, and signal timeline.

## Changelog

- 2026-07-13 — **Obsidian vault knowledge source.** New `makeObsidianAdapter()` in `ingestion.ts` ingests a local markdown vault (scoped to user-selected folders, `AppConfig.knowledge.vault`) as read-only context — notes become `document` nodes and `[[wikilinks]]` become `references` edges (`kindToNodeType`, `deriveContainer`, and the new `deriveWikilinkEdges` in `memory-graph.ts`). Vault signals are excluded from proactive trigger evaluation (`ambient.ts`) and from `VALID_SURFACES`/memory summarization — they enrich the graph and `semanticSignals` retrieval only, never generating intents. The fingerprint includes the note's resolved `wikilinks` list alongside its content hash, so a link that becomes resolvable only after its target note is created later still gets picked up on the next poll, not just within the same ingestion batch. See the new "Knowledge vault (Obsidian)" section above.

- 2026-06-30 — **GitHub container derivation fixed (`memory-graph.ts:deriveContainer`).** `deriveContainer` previously looked for `signal.raw.repository.full_name` which GitHub's `search_issues` API never returns. The function now parses `owner/repo` from `signal.url` (html_url, always present) via a new `parseGithubOwnerRepo` helper, with fallbacks to `signal.raw.repository_url` (api.github.com/repos/…) and legacy webhook-style fields. This means GitHub `pull_request` and `issue` nodes now correctly get a `repo` container node (`github:repo:owner/repo`) and a `part_of` edge — which activates `scope.ts:violatesScope`'s container comparison for Adobe-org filtering.

- 2026-06-06 — initial documentation; reflects ontology expansion in commit d8a8774 (4→14 node types, 7→19 edge types)
