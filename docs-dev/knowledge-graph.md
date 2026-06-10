# Knowledge Graph

mypa builds a persistent knowledge graph from external signals (GitHub, Jira, Slack) and its own actions. The graph is visible in the Memory page of the main window (`MemoryGraph.tsx`).

**Source files:**
- Ontology types: `src/shared/types.ts` — `NodeType`, `EdgeRel`
- Graph construction: `src/main/services/memory-graph.ts`
- DB schema: `src/main/db/schema.ts` — `graph_nodes`, `graph_edges`, `node_signals`
- IPC: `memory` namespace in `src/shared/types.ts`
- Renderer: `src/renderer/src/main-window/components/MemoryGraph.tsx`

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
| `document` | (reserved) | Future use |

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
| `references` | One item references another (e.g. a PR closing an issue) |

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

- 2026-06-06 — initial documentation; reflects ontology expansion in commit d8a8774 (4→14 node types, 7→19 edge types)
