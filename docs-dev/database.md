# Database

mypa uses SQLite via [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) (synchronous API).

- **Location:** `~/.mypa/data.db`
- **Journal mode:** WAL (`PRAGMA journal_mode = WAL`)
- **Foreign keys:** ON (`PRAGMA foreign_keys = ON`)
- **Sync mode:** NORMAL (`PRAGMA synchronous = NORMAL`) — safe with WAL; reduces fsyncs vs. FULL
- **Busy timeout:** 5000 ms (`PRAGMA busy_timeout = 5000`) — waits instead of throwing `SQLITE_BUSY`
- **Schema:** `src/main/db/schema.ts` — applied with `CREATE TABLE IF NOT EXISTS` on startup (no separate migration tool)
- **Query functions:** `src/main/db/index.ts` — typed wrappers around prepared statements
- **Initialization:** called from `src/main/index.ts` at startup via `initDb()`

---

## Tables

### Routines & runs

#### `routines`

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `name` | TEXT | Human-readable name |
| `cron` | TEXT | Standard cron expression |
| `actions` | TEXT | JSON array of `RoutineAction[]` |
| `prompt` | TEXT | Digest instructions sent to Claude |
| `enabled` | INTEGER | 0 / 1 |
| `created_at` | TEXT | ISO 8601 |

#### `routine_runs`

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `routine_id` | TEXT FK → `routines` | CASCADE DELETE |
| `routine_name` | TEXT | Denormalized for display after deletion |
| `started_at` | TEXT | ISO 8601 |
| `completed_at` | TEXT | Nullable |
| `raw_output` | TEXT | Concatenated MCP tool outputs |
| `digest` | TEXT | JSON-serialized `RoutineDigest` |
| `status` | TEXT | `RunStatus` value |
| `error` | TEXT | Nullable |

#### `routine_run_threads`

Chat messages for a run's follow-up conversation.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | |
| `run_id` | TEXT FK → `routine_runs` | CASCADE DELETE |
| `role` | TEXT | `user \| assistant \| system` |
| `content` | TEXT | |
| `timestamp` | TEXT | ISO 8601 |

---

### Plan items

#### `plan_items`

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `title` | TEXT | Short action-oriented title |
| `detail` | TEXT | Context or steps |
| `status` | TEXT | `PlanItemStatus` |
| `timing` | TEXT | `PlanItemTiming` |
| `source` | TEXT | `manual_input \| routine_suggestion` |
| `created_at` | TEXT | ISO 8601 |
| `actions` | TEXT | JSON array of `McpActionRef[]` |

#### `plan_item_threads`

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | |
| `item_id` | TEXT FK → `plan_items` | CASCADE DELETE |
| `role` | TEXT | |
| `content` | TEXT | |
| `timestamp` | TEXT | ISO 8601 |

#### `plan_item_history`

Status-change audit log.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | |
| `item_id` | TEXT FK → `plan_items` | CASCADE DELETE |
| `from_status` | TEXT | |
| `to_status` | TEXT | |
| `timestamp` | TEXT | ISO 8601 |

---

### Ambient intelligence

#### `signals`

Raw observed events from external surfaces. Deduplicated by `UNIQUE(surface, external_id)`.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `surface` | TEXT | `github \| jira \| slack` |
| `kind` | TEXT | e.g. `pull_request`, `issue`, `message` |
| `external_id` | TEXT | Surface-native ID |
| `fingerprint` | TEXT | Content hash for change detection |
| `title` | TEXT | |
| `body` | TEXT | |
| `actor` | TEXT | Username of the event actor |
| `url` | TEXT | |
| `raw` | TEXT | Full JSON payload from the API |
| `occurred_at` | TEXT | Nullable (when the event happened upstream) |
| `observed_at` | TEXT | When mypa observed it |
| `processed` | INTEGER | 0 / 1 — whether ingested into the graph |
| `embedding` | BLOB | Nullable — local embedding vector |
| `embedding_model` | TEXT | Nullable — model name that produced the embedding |

#### `intents`

Proposed actions derived from signal analysis.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | |
| `type` | TEXT | `action \| suggestion \| flag \| digest` |
| `trigger_kind` | TEXT | `spike \| staleness \| dependency \| threshold \| time` |
| `confidence` | REAL | 0–1 |
| `surface` | TEXT | Nullable |
| `verb` | TEXT | Nullable — action verb (e.g. `comment`, `review`) |
| `target` | TEXT | Nullable — URL or identifier |
| `payload` | TEXT | JSON `Record<string, unknown>` |
| `rationale` | TEXT | Human-readable explanation |
| `reversibility` | TEXT | `reversible \| irreversible` |
| `required_approval` | INTEGER | 0 / 1 |
| `tier` | INTEGER | Trust tier at creation time |
| `status` | TEXT | `IntentStatus` |
| `context_packet` | TEXT | JSON snapshot of graph context used for inference |
| `created_at` | TEXT | |
| `resolved_at` | TEXT | Nullable |
| `error` | TEXT | Nullable |

#### `intent_threads`

Conversation messages for a multi-round Suggest session on an intent. Mirrors the `plan_item_threads` pattern.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `intent_id` | TEXT FK → `intents` | CASCADE DELETE |
| `role` | TEXT | `'user'` or `'assistant'` |
| `content` | TEXT | Message body |
| `timestamp` | TEXT | ISO 8601 |

#### `action_log`

Audit log of intent lifecycle events.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | |
| `intent_id` | TEXT FK → `intents` | SET NULL on delete |
| `event` | TEXT | e.g. `created`, `approved`, `executed`, `challenged` |
| `action_type` | TEXT | Mirrors the intent's verb/type |
| `tier` | INTEGER | Nullable |
| `detail` | TEXT | JSON |
| `created_at` | TEXT | |

#### `autonomy_policy`

Per-action-type trust settings. Updated by approve/challenge/dismiss outcomes.

| Column | Type | Notes |
|---|---|---|
| `action_type` | TEXT PK | |
| `tier` | INTEGER | 0–3 |
| `tier_locked` | INTEGER | 0 / 1 — manual override prevents automatic drift |
| `approvals` | INTEGER | Lifetime approval count |
| `consecutive_approvals` | INTEGER | Streak used for tier promotion |
| `challenges` | INTEGER | Lifetime challenge count |
| `dismissals` | INTEGER | Lifetime dismissal count |
| `executions` | INTEGER | Lifetime execution count |
| `updated_at` | TEXT | |

---

### Knowledge graph

#### `graph_nodes`

`UNIQUE(type, key)` — upserting by (type, key) is the normal write path.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `type` | TEXT | `NodeType` — see [knowledge-graph.md](knowledge-graph.md) |
| `key` | TEXT | Stable identifier, e.g. `github:person:octocat` |
| `label` | TEXT | Human-readable display name |
| `attrs` | TEXT | JSON extra attributes |
| `weight` | REAL | Relevance weight (decays hourly) |
| `first_seen` | TEXT | ISO 8601 |
| `last_seen` | TEXT | ISO 8601 |

#### `graph_edges`

`UNIQUE(src_id, dst_id, rel)`.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `src_id` | TEXT FK → `graph_nodes` | CASCADE DELETE |
| `dst_id` | TEXT FK → `graph_nodes` | CASCADE DELETE |
| `rel` | TEXT | `EdgeRel` — see [knowledge-graph.md](knowledge-graph.md) |
| `weight` | REAL | Decays over time |
| `attrs` | TEXT | JSON |
| `first_seen` | TEXT | |
| `last_seen` | TEXT | |

#### `node_signals`

Links graph nodes to the signals that touched them (provides a per-node timeline).

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | |
| `node_id` | TEXT FK → `graph_nodes` | CASCADE DELETE |
| `signal_id` | TEXT FK → `signals` | CASCADE DELETE |
| `surface` | TEXT | Denormalized |
| `summary` | TEXT | Short description of what happened |
| `occurred_at` | TEXT | Nullable |
| `observed_at` | TEXT | |

`UNIQUE(node_id, signal_id)` prevents duplicates.

#### `memories`

Extracted facts, patterns, preferences, and statuses tied to graph nodes.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `content` | TEXT | The extracted fact |
| `type` | TEXT | `fact \| pattern \| preference \| status` |
| `confidence` | REAL | 0–1 |
| `importance` | REAL | 0–1 (used for retrieval ranking) |
| `surface` | TEXT | Origin surface |
| `node_id` | TEXT FK → `graph_nodes` | SET NULL on delete |
| `enforcement` | TEXT | `hard \| soft` (default `soft`) — `hard` memories are trusted system-prompt directives; `soft` are advisory context |
| `status` | TEXT | `active \| superseded` |
| `superseded_by` | TEXT | ID of the replacing memory |
| `created_at` | TEXT | |
| `last_accessed` | TEXT | Nullable |
| `embedding` | BLOB | Nullable — local embedding vector (stripped before IPC) |
| `embedding_model` | TEXT | Nullable — model name that produced the embedding |

#### `usage_events`

Records every individual Claude CLI call with its token counts and estimated cost. Populated by `src/main/services/usage.ts` via `dbInsertUsage()` in `src/main/db/index.ts`.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `source` | TEXT | `UsageSource` — which feature triggered the call (e.g. `routine_digest`, `plan_chat`, `inference`) |
| `model` | TEXT | Model id string (e.g. `claude-opus-4-8`) |
| `input_tokens` | INTEGER | Input token count |
| `output_tokens` | INTEGER | Output token count |
| `cache_creation_tokens` | INTEGER | Prompt-cache write tokens |
| `cache_read_tokens` | INTEGER | Prompt-cache read tokens |
| `cost_usd` | REAL | Estimated USD cost as reported by the Claude CLI |
| `created_at` | TEXT | ISO 8601 |

---

## Indexes

All indexes use `CREATE INDEX IF NOT EXISTS`.

| Index | Table | Columns | Purpose |
|---|---|---|---|
| `idx_routine_runs_routine_id` | `routine_runs` | `routine_id` | Fetch runs by routine |
| `idx_routine_run_threads_run_id` | `routine_run_threads` | `run_id` | Fetch thread for a run |
| `idx_plan_item_threads_item_id` | `plan_item_threads` | `item_id` | Fetch thread for an item |
| `idx_intent_threads_intent_id` | `intent_threads` | `intent_id` | Fetch thread for an intent |
| `idx_plan_items_status` | `plan_items` | `status` | Filter by status |
| `idx_signals_unprocessed` | `signals` | `processed, observed_at` | Find unprocessed signals for ingestion |
| `idx_signals_surface` | `signals` | `surface, occurred_at` | Surface-scoped queries |
| `idx_graph_edges_src` | `graph_edges` | `src_id` | Outgoing edges |
| `idx_graph_edges_dst` | `graph_edges` | `dst_id` | Incoming edges |
| `idx_graph_nodes_weight` | `graph_nodes` | `weight` | Top-N by relevance |
| `idx_graph_nodes_last_seen` | `graph_nodes` | `last_seen` | Decay candidate selection |
| `idx_intents_status` | `intents` | `status, created_at` | Pending intent feed |
| `idx_action_log_type` | `action_log` | `action_type, created_at` | Policy analysis |
| `idx_node_signals_node` | `node_signals` | `node_id, observed_at` | Node timeline |
| `idx_memories_active` | `memories` | `status, importance` | Active memory retrieval |
| `idx_memories_node` | `memories` | `node_id` | Memories for a node |
| `idx_usage_events_created` | `usage_events` | `created_at` | Time-range queries |
| `idx_usage_events_source` | `usage_events` | `source, created_at` | Per-source breakdown |

---

## JSON-as-TEXT columns

Several columns store JSON as TEXT and are parsed in the query layer:

- `routines.actions` → `RoutineAction[]`
- `plan_items.actions` → `McpActionRef[]`
- `routine_runs.digest` → `RoutineDigest`
- `signals.raw` → full API payload
- `graph_nodes.attrs`, `graph_edges.attrs` → freeform attributes
- `intents.payload`, `intents.context_packet` → typed objects

---

## Migration approach

There is no migration framework. `initSchema()` uses `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`. Additive schema changes (new columns) use `ALTER TABLE` wrapped in a try/catch that silently ignores "column already exists" errors. Structural changes (constraint changes) use an explicit table-rename migration block inside `initSchema()`. See `src/main/db/schema.ts` for examples.

### `check_ins`

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `status` | TEXT | `active \| extracting \| complete \| error` |
| `trigger` | TEXT | `manual \| scheduled` |
| `started_at` | TEXT | ISO 8601 |
| `completed_at` | TEXT | Nullable; set when `end()` is called |
| `briefing` | TEXT | Agent's opening self-report (plain text) |
| `extraction_summary` | TEXT | Nullable; JSON `CheckInExtractionSummary` after extraction |

### `checkin_messages`

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `checkin_id` | TEXT FK → `check_ins` | CASCADE DELETE |
| `role` | TEXT | `user \| assistant` |
| `content` | TEXT | Message text |
| `timestamp` | TEXT | ISO 8601 |

Indexes: `idx_checkin_messages_checkin` (checkin_id, timestamp), `idx_check_ins_status` (status, started_at).

## Vector search — current approach and future path

Vectors are stored as raw little-endian Float32 BLOBs and similarity search is performed with a brute-force dot-product loop in JavaScript (vectors are L2-normalized, so cosine similarity = dot product). This is sufficient for current scale:

- Signal retrieval cap: ≤500 rows / last 7 days (`memory-graph.ts`)
- Similarity-edge building: top-12 nodes, ~66 comparisons (hourly)
- Memory dedup: ≤5 candidates

**sqlite-vec decision (2026-06-15):** Do not adopt sqlite-vec yet. The JS loop is sub-millisecond at current scale; the real cost is ONNX inference, which sqlite-vec doesn't address. Upstream sqlite-vec is pre-v1 ("expect breaking changes") and adopting it adds native-extension surface (`loadExtension`, per-platform binaries, asarUnpack) that the codebase currently avoids. Revisit at ~10k+ vectors using the [`@photostructure/sqlite-vec` fork](https://www.npmjs.com/package/@photostructure/sqlite-vec) (v1.x, Electron-asar-aware, production-ready).

---

## Changelog

- 2026-06-15 — **Memory embeddings + transactions + pragma tuning:** `memories` table gains two new nullable columns via additive `ALTER TABLE` migration: `embedding BLOB` and `embedding_model TEXT` (mirrors the existing `signals` pattern). New DB helpers: `dbSetMemoryEmbedding(id, buf, model)`, `dbGetMemoryEmbedding(id) → Buffer | null`, `dbGetMemoriesMissingEmbeddings(limit) → Memory[]`. `deserializeMemory` now strips the embedding columns before returning (same pattern as `deserializeSignal`). `embeddings.ts` exports `MODEL_NAME` (was private) and adds `enqueueMemoryBackfill()` which drains missing embeddings in batches of 100 via the shared serialized queue; called fire-and-forget from `startAmbient` alongside the existing `enqueueBackfill`. `memories.ts` — `findSuperseded` now accepts a pre-computed `Float32Array | null` query vector (computed once in the caller) and reads each candidate's stored BLOB via `dbGetMemoryEmbedding`, falling back to live `embedText` only for unbackfilled rows; after `dbCreateMemory` the query vector is persisted via `dbSetMemoryEmbedding`. Two multi-statement writes wrapped in `db.transaction()`: `dbUpdatePlanItemStatus` (UPDATE plan_items + INSERT plan_item_history) and `dbInsertSignal` update path (UPDATE + optional DELETE-dup + retry). Pragmas added to the initial `db.exec()` block: `PRAGMA synchronous = NORMAL` (safe with WAL, fewer fsyncs) and `PRAGMA busy_timeout = 5000` (waits instead of throwing SQLITE_BUSY).
- 2026-06-11 — **"Needs me" relation fields on signals; urgency on intents:** `signals` table gains four columns via additive `ALTER TABLE` migrations: `relation TEXT` (review_requested/assigned/mentioned/involved/dm/thread_reply), `directed INTEGER NOT NULL DEFAULT 0` (1 = latest non-owner actor directed this at the owner), `last_actor TEXT` (latest comment/event author), `due_at TEXT` (Jira duedate). `intents` table gains `urgency REAL NOT NULL DEFAULT 0`. All columns added via `tryExec` (safe on existing DBs). The `signals_mig` rebuild path updated to include the four new columns with safe defaults. `dbInsertSignal` INSERT and UPDATE statements updated to include the new columns. `deserializeSignal` coerces `directed: row.directed === 1`. `dbCreateIntent` INSERT includes `urgency`. New `dbGetDirectedSignals()` function returns signals with `directed=1` ordered by `observed_at DESC`.
- 2026-06-10 — **Hard/soft memory enforcement:** added `enforcement TEXT NOT NULL DEFAULT 'soft'` column to `memories` (additive `ALTER TABLE` migration). New DB helper `dbGetActiveHardMemories()` returns all active hard memories (no cap), used by `buildDirectivesClause()` in `config.ts` to inject them as trusted standing directives into inference system prompts. New `MemoryEnforcement` and `ScopeConfig` types in `src/shared/types.ts`. New `src/main/services/scope.ts` with `violatesScope(obj, focusNodes)` deterministic filter applied at both ambient chokepoints (`runAmbientCycle` and `routeIntent`). `AppConfig` extended with `scope?: ScopeConfig`.
- 2026-06-10 — **Suggest re-proposal thread:** added `intent_threads` table (mirrors `plan_item_threads` with `intent_id FK → intents CASCADE DELETE`) and `idx_intent_threads_intent_id` index. New query helpers in `db/index.ts`: `dbAddIntentMessage(intentId, role, content)`, `dbGetIntentThread(intentId) → ChatMessage[]`, and `dbReproposeIntent(id, { verb, target, payload, rationale, confidence, reversibility, required_approval })` — updates proposal fields in-place without touching `status`, keeping the intent actionable across multiple Suggest rounds.
- 2026-06-09 — **graph weight cap:** `dbBumpNodeWeight` and `dbUpsertEdge` now apply a hard cap (`MIN(weight + delta, 10.0)`) to prevent unbounded accumulation on frequently-updated nodes/edges. Without the cap, nodes polled hundreds of times could reach weights in the hundreds (e.g. 409.567), overwhelming the decay schedule and dominating every context-packet query. The cap is expressed as `GRAPH_NODE_WEIGHT_CAP` / `GRAPH_EDGE_WEIGHT_CAP` constants in `db/index.ts`.
- 2026-06-09 — `PlanItemSource` extended with `'ambient_action'`; new DB function `dbCreateAmbientActionRecord(intent: Intent): PlanItem` inserts a done plan item representing an agent-executed ambient action (status `'done'`, source `'ambient_action'`, timing `'anytime'`). No schema change — the `plan_items` table already supports these values.
- 2026-06-08 — added `check_ins` and `checkin_messages` tables with indexes; new DB functions `dbCreateCheckIn`, `dbGetCheckIn`, `dbGetActiveCheckIn`, `dbGetCheckIns`, `dbUpdateCheckIn`, `dbAddCheckInMessage`, `dbGetCheckInThread`
- 2026-06-07 — added `usage_events` table + indexes (`idx_usage_events_created`, `idx_usage_events_source`); new query functions `dbInsertUsage`, `dbGetUsageSummary`, `dbGetUsageByDay`, `dbGetUsageBySource`, `dbGetUsageByModel`, `dbGetRecentUsage` in `src/main/db/index.ts`
- 2026-06-07 — added `dbGetAllMemories()` (all rows incl. superseded, ordered by `created_at`); used by the memory export feature; `dbUpsertPolicy` now accepts `consecutive_approvals` reset to fix the trust-accumulation streak bug
- 2026-06-06 — initial documentation; reflects schema as of commit d8a8774
