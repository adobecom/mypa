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
| `covered_entities` | TEXT | JSON-serialized `CoveredEntity[]` — work items detected in the MCP output; populated after digest generation (added 2026-06-17) |

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
| `metadata` | TEXT | JSON — optional `ProposedChatAction` when the message carries a write-action proposal (added 2026-06-19 via `ALTER TABLE`) |

Query helpers: `dbAddPlanMessage(itemId, role, content, metadata?)`, `dbGetPlanThread(itemId) → ChatMessage[]` (parses `metadata` into `message.action`), `dbUpdatePlanMessageMetadata(messageId, metadata)` (used by `approvePlanAction`/`dismissPlanAction`).

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
| `relation` | TEXT | Nullable — `review_requested \| assigned \| mentioned \| involved \| dm \| thread_reply` |
| `directed` | INTEGER | 0 / 1 — 1 when a non-owner actor directed this item at the owner |
| `last_actor` | TEXT | Nullable — most recent commenter / event author |
| `due_at` | TEXT | Nullable — deadline from Jira duedate or GitHub milestone |
| `last_seen_at` | TEXT | Nullable — ISO timestamp of the last adapter poll that returned this signal (updated on every poll hit, even unchanged fingerprint); used by freshness revalidation to detect disappeared items |

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
| `urgency` | REAL | Default `0` — added via `ALTER TABLE` (see Changelog, 2026-06-11) |
| `actions` | TEXT | JSON `McpActionRef[]`, default `'[]'` — added via `ALTER TABLE` (see Changelog, 2026-06-26); when non-empty, `executeActions()` uses this instead of `surface`/`verb`/`payload` |
| `cta_label` | TEXT | Nullable — LLM-authored primary-button label (e.g. "Merge PR #482"), added via `ALTER TABLE` (see Changelog, 2026-07-14); renderer falls back to a heuristic label when absent |

#### `intent_threads` _(deprecated)_

Conversation messages for the old standalone Suggest session on an intent. **Deprecated as of 2026-06-17** — the Suggest flow was merged into the streaming Chat panel; new writes go to `intent_chat_threads` instead. Existing rows are preserved for historical reference. No new rows are written.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `intent_id` | TEXT FK → `intents` | CASCADE DELETE |
| `role` | TEXT | `'user'` or `'assistant'` |
| `content` | TEXT | Message body |
| `timestamp` | TEXT | ISO 8601 |

#### `intent_chat_threads`

Streaming "Chat about it" conversation messages for an intent. This is the active chat table. `intent_threads` (the old Suggest table) is deprecated — new messages go here. Available on all intents including terminal/failed ones.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `intent_id` | TEXT FK → `intents` | CASCADE DELETE |
| `role` | TEXT | `'user'` or `'assistant'` |
| `content` | TEXT | Message body |
| `timestamp` | TEXT | ISO 8601 |
| `metadata` | TEXT | JSON — optional `ProposedChatAction` when the message carries a write-action proposal (added 2026-06-18 via `ALTER TABLE`) |

Query helpers: `dbAddIntentChatMessage(intentId, role, content, metadata?)`, `dbGetIntentChatThread(intentId) → ChatMessage[]` (parses `metadata` into `message.action`), `dbUpdateIntentChatMessageMetadata(messageId, metadata)` (used by approve/dismiss to update action status).

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

#### `work_products`

One row per `author_fix` intent (`UNIQUE(intent_id)`) — the durable record of a code-authoring attempt: its worktree/branch and the diff produced there, through shipping. See [code-authoring.md](code-authoring.md) and `authoring.ts`/`worktree.ts`.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | |
| `intent_id` | TEXT FK → `intents` | `UNIQUE`, CASCADE DELETE |
| `repo_id` | TEXT | `RepoLink.id` (config-stored, not a DB FK) |
| `worktree_path` | TEXT | Absolute path under `~/.mypa/worktrees/` |
| `branch` | TEXT | `mypa/<slug>` |
| `base_branch` | TEXT | Branch the worktree was created from |
| `status` | TEXT | `WorkProductStatus`: `drafting \| ready \| shipping \| shipped \| failed \| abandoned` |
| `summary` | TEXT | Model-written description of the change |
| `diff_stat` | TEXT | `git diff --stat` output |
| `files_changed` | TEXT | JSON `string[]`, default `'[]'` |
| `diff` | TEXT | Full unified diff (cached so it's still viewable after the worktree is pruned) |
| `error` | TEXT | Nullable |
| `pr_url` | TEXT | Nullable — set once `create_pull_request` succeeds |
| `created_at` | TEXT | |
| `shipped_at` | TEXT | Nullable |

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
| `idx_signals_last_seen` | `signals` | `surface, last_seen_at` | Freshness revalidation — find signals not seen recently per surface |
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
| `idx_work_products_status` | `work_products` | `status, created_at` | Filter by lifecycle status |

---

## JSON-as-TEXT columns

Several columns store JSON as TEXT and are parsed in the query layer:

- `routines.actions` → `RoutineAction[]`
- `plan_items.actions` → `McpActionRef[]`
- `routine_runs.digest` → `RoutineDigest`
- `signals.raw` → full API payload
- `graph_nodes.attrs`, `graph_edges.attrs` → freeform attributes
- `intents.payload`, `intents.context_packet` → typed objects
- `work_products.files_changed` → `string[]`

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

- 2026-07-14 — **`intents.cta_label` column:** additive `ALTER TABLE` migration adds `cta_label TEXT` (nullable) to the `intents` table. Stores an LLM-authored, short imperative button label for the intent's proposed action (e.g. "Merge PR #482", "Post comment") — added to the `IntentObject` JSON schema across the lightweight, routine, re-propose, and deep-enrichment `inference.ts` prompt variants (not the author-fix path — those intents render via `WorkProductCard`, not `IntentCard`) and parsed by `parseIntentObject`/`parseDeepIntentObject`. `dbCreateIntent` persists `obj.cta_label ?? null`; `deserializeIntent` passes it through via its existing `...row` spread (no code change needed there). `dbReproposeIntent` accepts an optional `cta_label` update so re-proposing an intent can refresh its label. `IntentCard.tsx`'s primary action button prefers `cta_label` when present, falling back to its existing heuristic label (`buildActionCtaLabel`) for older rows or when the model omits it. `ProposedChatAction` gained the same field and `ChatThread.tsx`'s `ActionChip` Approve button checks it too, but no current code path populates `cta_label` on a newly-created pending `ProposedChatAction` — that consumer is inert until a producer exists.

- 2026-07-09 — **New `work_products` table (20th table):** additive `CREATE TABLE IF NOT EXISTS` in `schema.ts`, `UNIQUE(intent_id)` FK → `intents` (CASCADE DELETE). Backs the code-authoring flow — see [code-authoring.md](code-authoring.md), `authoring.ts`, `worktree.ts`. New index `idx_work_products_status`. New CRUD in `db/index.ts`: `dbCreateWorkProduct`, `dbGetWorkProduct`, `dbGetWorkProductByIntent`, `dbUpdateWorkProduct`, `deserializeWorkProduct` (parses `files_changed` JSON).

- 2026-07-07 — **Signals migration hardened:** the `signals` table's `UNIQUE(surface, external_id, fingerprint)` → `UNIQUE(surface, external_id)` migration in `schema.ts` (`CREATE signals_mig` / `INSERT` / `DELETE node_signals` / `DROP` / `RENAME`) now runs inside a single `db.transaction()` instead of as a bare multi-statement `db.exec()`. Previously a crash between `DROP TABLE signals` and the `RENAME` would permanently lose the table with no rollback; now the whole sequence is atomic. `foreign_keys` is still toggled OFF/ON outside the transaction (SQLite treats that pragma as a no-op inside one), but the ON restore is now in a `finally` so a migration failure can't leave FK enforcement permanently disabled.

- 2026-07-07 — **Doc fix:** the `intents` table reference above was missing the `urgency` and `actions` columns, even though both were already documented below (2026-06-11 and 2026-06-26 entries). Table now matches the changelog and the actual schema.

- 2026-06-26 — **`intents.actions` column:** additive `ALTER TABLE` migration adds `actions TEXT NOT NULL DEFAULT '[]'` to the `intents` table. Stores a JSON-encoded `McpActionRef[]` array — the concrete MCP tool calls proposed by agentic deep-enrichment (`inferDeepIntent`). When non-empty, `executeActions()` in `ambient.ts` uses this array instead of the legacy `surface/verb/payload` columns for execution. `dbCreateIntent` persists `obj.actions ?? []`; `deserializeIntent` parses it back into `McpActionRef[]`. New helper `dbUpdateIntentActions(id, actions)` updates the column in-place (used by `ambientApproveIntent` when the user edits the draft text).

- 2026-06-18 — **`autonomy_policy` drift normalization:** one-time idempotent `UPDATE autonomy_policy SET tier = 2 WHERE tier = 3 AND tier_locked = 0` runs on every startup (in `schema.ts` after the `tryExec` migration block). Reverts rows whose tier drifted to 3 via repeated challenge feedback (which was previously uncapped) back to tier 2 (Approve). Rows with `tier_locked = 1` (explicit user Locks set via Settings) are intentionally preserved. The statement is safe to re-run: once `AUTO_ESCALATE_CEILING = 2` is in effect, no new `tier = 3 AND tier_locked = 0` rows can be created, so subsequent runs are always no-ops. No schema change.

- 2026-06-19 — **`plan_item_threads.metadata` column:** additive `ALTER TABLE` migration adds `metadata TEXT` (nullable JSON) to `plan_item_threads`, mirroring the same column on `intent_chat_threads`. Stores `ProposedChatAction` for write-action proposals in plan-item chat. `dbAddPlanMessage` gains optional `metadata?` param; `dbGetPlanThread` parses `metadata` into `message.action`; new `dbUpdatePlanMessageMetadata(messageId, metadata)` helper updates the column in-place.

- 2026-06-18 — **`intent_chat_threads.metadata` column:** additive `ALTER TABLE` migration adds `metadata TEXT` (nullable JSON) to `intent_chat_threads`. Stores `ProposedChatAction` when a chat message carries a pending/executed/dismissed write-action proposal. `dbAddIntentChatMessage` gains optional `metadata?` param and includes it in the INSERT. `dbGetIntentChatThread` parses `metadata` into `message.action`. New helper `dbUpdateIntentChatMessageMetadata(messageId, metadata)` updates the column in-place (used by `approveChatAction`/`dismissChatAction`).

- 2026-06-17 — **`intent_threads` deprecated:** the standalone Suggest re-proposal conversation table (`intent_threads`) is no longer written to — the Suggest flow was merged into the streaming Chat panel. No schema change; existing rows are preserved. All new conversation messages go to `intent_chat_threads`.

- 2026-06-17 — **Intent chat thread table — `intent_chat_threads`:** new table (mirroring `plan_item_threads`) for the streaming "Chat about it" per-intent conversation thread. Schema: `id TEXT PK, intent_id TEXT FK → intents CASCADE DELETE, role TEXT, content TEXT, timestamp TEXT`. Index: `idx_intent_chat_threads_intent_id`. Added via `CREATE TABLE IF NOT EXISTS` (no migration needed for fresh installs; existing installs pick it up on first startup). New query helpers: `dbAddIntentChatMessage(intentId, role, content)`, `dbGetIntentChatThread(intentId) → ChatMessage[]`.

- 2026-06-17 — **Routine run entity linkage — `routine_runs.covered_entities`:** `routine_runs` table gains `covered_entities TEXT` (nullable) via additive `ALTER TABLE` migration. Stores a JSON-serialized `CoveredEntity[]` snapshot of work items (PRs, issues, Slack messages) detected in the run's raw MCP output. Populated by the new `entity-link.ts` service after digest generation. `deserializeRun` JSON-parses it (default `[]`). `dbUpdateRun` field type extended. New `dbGetRecentSignalsAllSurfaces(sinceIso, limit)` helper queries all signals across surfaces in a single SELECT for use by the entity-link scanner. `CoveredEntity` interface added to `src/shared/types.ts`; `RoutineRun.covered_entities: CoveredEntity[]` field added.

- 2026-06-17 — **Resolution cooldown query — `dbGetResolvedIntentsSince`:** new read-only helper in `src/main/db/index.ts` that returns all terminal intents (`executed`, `dismissed`, `challenged`, `failed`, `expired`) whose `resolved_at` is at or after a given ISO cutoff. No schema change. Used by `suppressedFocusNodeIds()` in `ambient.ts` to suppress re-surfacing the same work item during a post-resolution cooldown window.

- 2026-06-16 — **Startup crash guard for native module:** `db/index.ts` — top-level `import BetterSqlite3 from 'better-sqlite3'` replaced with `import type BetterSqlite3 from 'better-sqlite3'` (type-only, erased at compile time) and a lazy `require('better-sqlite3')` inside `initDb()`. This makes a missing, misbuilt, or ABI-mismatched native binary catchable at runtime (the load error now throws inside `initDb()`) rather than crashing the process before any `try/catch` can run. `index.ts` wraps the `initDb()` call in `try/catch`; on failure it calls `dialog.showErrorBox()` with a clear message referencing `npm run postinstall`, then calls `app.quit()`.
- 2026-06-15 — **Freshness revalidation — `signals.last_seen_at`:** `signals` table gains `last_seen_at TEXT` (nullable) via additive `ALTER TABLE` migration. New index `idx_signals_last_seen ON signals(surface, last_seen_at)`. `dbInsertSignal` now stamps `last_seen_at = observed_at` on every path: INSERT, changed-fingerprint UPDATE, and the previously no-op unchanged-fingerprint path (which now does a cheap `UPDATE signals SET last_seen_at = ? WHERE id = ?` before returning). `deserializeSignal` includes `last_seen_at`. `Signal` interface and `SignalInput` type updated (`last_seen_at` omitted from `SignalInput` since it is set by the DB layer). Used by `revalidatePendingIntents()` in `ambient.ts` to detect work items that have disappeared from active adapter feeds.
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
