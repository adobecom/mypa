// Lazy-loaded so a failed native build is catchable at runtime rather than
// crashing the process at module-import time (import throws synchronously,
// before any try/catch in main() can run).
import type BetterSqlite3 from 'better-sqlite3'
import { join } from 'path'
import { app } from 'electron'
import { mkdirSync, unlinkSync } from 'fs'
import { initSchema } from './schema'
import { v4 as uuidv4 } from 'uuid'
import type {
  Routine,
  RoutineInput,
  RoutineRun,
  RunStatus,
  PlanItem,
  PlanDraft,
  PlanItemStatus,
  ChatMessage,
  McpActionRef,
  RoutineAction,
  Signal,
  SignalInput,
  GraphNode,
  GraphEdge,
  NodeType,
  EdgeRel,
  Intent,
  IntentObject,
  TriggerKind,
  IntentStatus,
  AutonomyPolicy,
  ActionLogEntry,
  Tier,
  Memory,
  MemoryInput,
  NodeSignalLink,
  UsageEvent,
  UsageSource,
  UsageSummary,
  UsageDailyPoint,
  UsageBreakdownRow,
  CheckIn,
  CheckInStatus
} from '@shared/types'
import { createHash } from 'crypto'

let _db: BetterSqlite3.Database | null = null

export function getDb(): BetterSqlite3.Database {
  if (!_db) throw new Error('Database not initialized')
  return _db
}

export function initDb(): void {
  const dataDir = join(app.getPath('home'), '.mypa')
  mkdirSync(dataDir, { recursive: true })
  const dbPath = join(dataDir, 'data.db')
  // require() here (not at module top) so a missing/misbuilt native binary
  // throws inside this function rather than at import time, where it cannot
  // be caught.  If it fails, the caller (main.ts) shows an error dialog.
  const Database = require('better-sqlite3') as typeof BetterSqlite3  // eslint-disable-line @typescript-eslint/no-var-requires
  _db = new Database(dbPath) as BetterSqlite3.Database
  initSchema(_db)
}

/**
 * Closes the database handle and deletes data.db (plus WAL sidecars).
 * After this call, initDb() will recreate a fresh database on next startup.
 * Call just before app.relaunch() so there are no open file handles.
 */
export function resetDatabase(): void {
  try { _db?.close() } catch { /* ignore */ }
  _db = null

  const dataDir = join(app.getPath('home'), '.mypa')
  const dbPath = join(dataDir, 'data.db')
  for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try { unlinkSync(p) } catch { /* file may not exist — that's fine */ }
  }
}

// ─── Routines ────────────────────────────────────────────────────────────────

export function dbGetRoutines(): Routine[] {
  const rows = getDb().prepare('SELECT * FROM routines ORDER BY created_at DESC').all() as any[]
  return rows.map(deserializeRoutine)
}

export function dbGetRoutine(id: string): Routine | null {
  const row = getDb().prepare('SELECT * FROM routines WHERE id = ?').get(id) as any
  return row ? deserializeRoutine(row) : null
}

export function dbCreateRoutine(data: RoutineInput): Routine {
  const id = uuidv4()
  const created_at = new Date().toISOString()
  getDb()
    .prepare(
      'INSERT INTO routines (id, name, cron, actions, prompt, enabled, created_at) VALUES (?,?,?,?,?,?,?)'
    )
    .run(id, data.name, data.cron, JSON.stringify(data.actions), data.prompt, data.enabled ? 1 : 0, created_at)
  return dbGetRoutine(id)!
}

export function dbUpdateRoutine(id: string, data: Partial<RoutineInput>): Routine {
  const current = dbGetRoutine(id)
  if (!current) throw new Error(`Routine ${id} not found`)
  const merged = { ...current, ...data }
  getDb()
    .prepare(
      'UPDATE routines SET name=?, cron=?, actions=?, prompt=?, enabled=? WHERE id=?'
    )
    .run(merged.name, merged.cron, JSON.stringify(merged.actions), merged.prompt, merged.enabled ? 1 : 0, id)
  return dbGetRoutine(id)!
}

export function dbDeleteRoutine(id: string): void {
  getDb().prepare('DELETE FROM routines WHERE id = ?').run(id)
}

function deserializeRoutine(row: any): Routine {
  return {
    ...row,
    enabled: row.enabled === 1,
    actions: safeJsonParse<RoutineAction[]>(row.actions, [])
  }
}

// ─── Routine Runs ─────────────────────────────────────────────────────────────

export function dbCreateRun(routineId: string, routineName: string): RoutineRun {
  const id = uuidv4()
  const started_at = new Date().toISOString()
  getDb()
    .prepare(
      'INSERT INTO routine_runs (id, routine_id, routine_name, started_at, status) VALUES (?,?,?,?,?)'
    )
    .run(id, routineId, routineName, started_at, 'running')
  return dbGetRun(id)!
}

export function dbGetRun(id: string): RoutineRun | null {
  const row = getDb().prepare('SELECT * FROM routine_runs WHERE id = ?').get(id) as any
  return row ? deserializeRun(row) : null
}

export function dbUpdateRun(
  id: string,
  fields: Partial<{
    completed_at: string
    raw_output: string
    digest: string
    status: RunStatus
    error: string
    covered_entities: string
  }>
): void {
  const sets = Object.keys(fields)
    .map((k) => `${k} = ?`)
    .join(', ')
  const vals = [...Object.values(fields), id]
  getDb()
    .prepare(`UPDATE routine_runs SET ${sets} WHERE id = ?`)
    .run(...vals)
}

export function dbGetRunsForRoutine(routineId: string, limit = 20): RoutineRun[] {
  const rows = getDb()
    .prepare('SELECT * FROM routine_runs WHERE routine_id = ? ORDER BY started_at DESC LIMIT ?')
    .all(routineId, limit) as any[]
  return rows.map(deserializeRun)
}

export function dbGetAllRuns(limit = 50): RoutineRun[] {
  const rows = getDb()
    .prepare('SELECT * FROM routine_runs ORDER BY started_at DESC LIMIT ?')
    .all(limit) as any[]
  return rows.map(deserializeRun)
}

function deserializeRun(row: any): RoutineRun {
  return {
    ...row,
    covered_entities: row.covered_entities ? JSON.parse(row.covered_entities) : []
  }
}

// ─── Threads ──────────────────────────────────────────────────────────────────

export function dbAddRunMessage(runId: string, role: string, content: string): ChatMessage {
  const id = uuidv4()
  const timestamp = new Date().toISOString()
  getDb()
    .prepare('INSERT INTO routine_run_threads (id, run_id, role, content, timestamp) VALUES (?,?,?,?,?)')
    .run(id, runId, role, content, timestamp)
  return { id, role: role as any, content, timestamp }
}

export function dbGetRunThread(runId: string): ChatMessage[] {
  const rows = getDb()
    .prepare('SELECT * FROM routine_run_threads WHERE run_id = ? ORDER BY timestamp ASC')
    .all(runId) as any[]
  return rows.map((r) => ({ id: r.id, role: r.role, content: r.content, timestamp: r.timestamp }))
}

// ─── Intent threads (Suggest) ─────────────────────────────────────────────────

export function dbAddIntentMessage(intentId: string, role: string, content: string): ChatMessage {
  const id = uuidv4()
  const timestamp = new Date().toISOString()
  getDb()
    .prepare('INSERT INTO intent_threads (id, intent_id, role, content, timestamp) VALUES (?,?,?,?,?)')
    .run(id, intentId, role, content, timestamp)
  return { id, role: role as any, content, timestamp }
}

export function dbGetIntentThread(intentId: string): ChatMessage[] {
  const rows = getDb()
    .prepare('SELECT * FROM intent_threads WHERE intent_id = ? ORDER BY timestamp ASC')
    .all(intentId) as any[]
  return rows.map((r) => ({ id: r.id, role: r.role, content: r.content, timestamp: r.timestamp }))
}

// ─── Intent chat threads (streaming "Chat about it") ──────────────────────────

export function dbAddIntentChatMessage(
  intentId: string,
  role: string,
  content: string,
  metadata?: Record<string, unknown>
): ChatMessage {
  const id = uuidv4()
  const timestamp = new Date().toISOString()
  const metaStr = metadata ? JSON.stringify(metadata) : null
  getDb()
    .prepare('INSERT INTO intent_chat_threads (id, intent_id, role, content, timestamp, metadata) VALUES (?,?,?,?,?,?)')
    .run(id, intentId, role, content, timestamp, metaStr)
  return {
    id, role: role as any, content, timestamp,
    ...(metadata ? { action: metadata as any } : {})
  }
}

export function dbGetIntentChatThread(intentId: string): ChatMessage[] {
  const rows = getDb()
    .prepare('SELECT * FROM intent_chat_threads WHERE intent_id = ? ORDER BY timestamp ASC')
    .all(intentId) as any[]
  return rows.map((r) => {
    const msg: ChatMessage = { id: r.id, role: r.role, content: r.content, timestamp: r.timestamp }
    if (r.metadata) {
      try { (msg as any).action = JSON.parse(r.metadata) } catch { /* corrupt metadata — ignore */ }
    }
    return msg
  })
}

export function dbUpdateIntentChatMessageMetadata(messageId: string, metadata: Record<string, unknown>): void {
  getDb()
    .prepare('UPDATE intent_chat_threads SET metadata = ? WHERE id = ?')
    .run(JSON.stringify(metadata), messageId)
}

/**
 * Update the proposal fields on an intent in-place without changing its status.
 * Used by the Suggest loop after each re-proposal round.
 */
export function dbReproposeIntent(
  id: string,
  update: {
    verb?: string
    target?: string
    payload?: Record<string, unknown>
    rationale?: string
    confidence?: number
    reversibility?: string
    required_approval?: boolean
  }
): void {
  const db = getDb()
  if (update.verb !== undefined) db.prepare('UPDATE intents SET verb = ? WHERE id = ?').run(update.verb, id)
  if (update.target !== undefined) db.prepare('UPDATE intents SET target = ? WHERE id = ?').run(update.target, id)
  if (update.payload !== undefined) db.prepare('UPDATE intents SET payload = ? WHERE id = ?').run(JSON.stringify(update.payload), id)
  if (update.rationale !== undefined) db.prepare('UPDATE intents SET rationale = ? WHERE id = ?').run(update.rationale, id)
  if (update.confidence !== undefined) db.prepare('UPDATE intents SET confidence = ? WHERE id = ?').run(update.confidence, id)
  if (update.reversibility !== undefined) db.prepare('UPDATE intents SET reversibility = ? WHERE id = ?').run(update.reversibility, id)
  if (update.required_approval !== undefined) db.prepare('UPDATE intents SET required_approval = ? WHERE id = ?').run(update.required_approval ? 1 : 0, id)
}

export function dbAddPlanMessage(
  itemId: string,
  role: string,
  content: string,
  metadata?: Record<string, unknown>
): ChatMessage {
  const id = uuidv4()
  const timestamp = new Date().toISOString()
  getDb()
    .prepare('INSERT INTO plan_item_threads (id, item_id, role, content, timestamp, metadata) VALUES (?,?,?,?,?,?)')
    .run(id, itemId, role, content, timestamp, metadata ? JSON.stringify(metadata) : null)
  const msg: ChatMessage = { id, role: role as any, content, timestamp }
  if (metadata) (msg as any).action = metadata
  return msg
}

export function dbGetPlanThread(itemId: string): ChatMessage[] {
  const rows = getDb()
    .prepare('SELECT * FROM plan_item_threads WHERE item_id = ? ORDER BY timestamp ASC')
    .all(itemId) as any[]
  return rows.map((r) => {
    const msg: ChatMessage = { id: r.id, role: r.role, content: r.content, timestamp: r.timestamp }
    if (r.metadata) {
      try { (msg as any).action = JSON.parse(r.metadata) } catch { /* corrupt metadata — ignore */ }
    }
    return msg
  })
}

export function dbUpdatePlanMessageMetadata(messageId: string, metadata: Record<string, unknown>): void {
  getDb()
    .prepare('UPDATE plan_item_threads SET metadata = ? WHERE id = ?')
    .run(JSON.stringify(metadata), messageId)
}

// ─── Plan Items ───────────────────────────────────────────────────────────────

export function dbGetPlanItems(): PlanItem[] {
  const rows = getDb()
    .prepare("SELECT * FROM plan_items WHERE status NOT IN ('done','skipped') ORDER BY created_at ASC")
    .all() as any[]
  return rows.map(deserializePlanItem)
}

export function dbGetAllPlanItems(): PlanItem[] {
  const rows = getDb().prepare('SELECT * FROM plan_items ORDER BY created_at ASC').all() as any[]
  return rows.map(deserializePlanItem)
}

export function dbGetPlanItem(id: string): PlanItem | null {
  const row = getDb().prepare('SELECT * FROM plan_items WHERE id = ?').get(id) as any
  return row ? deserializePlanItem(row) : null
}

export function dbCreatePlanItem(draft: PlanDraft): PlanItem {
  const id = uuidv4()
  const created_at = new Date().toISOString()
  getDb()
    .prepare(
      'INSERT INTO plan_items (id, title, detail, status, timing, source, created_at, actions) VALUES (?,?,?,?,?,?,?,?)'
    )
    .run(
      id,
      draft.title,
      draft.detail,
      'pending',
      draft.timing,
      'manual_input',
      created_at,
      JSON.stringify(draft.actions)
    )
  return dbGetPlanItem(id)!
}

// Creates a read-only done record for an intent the agent executed autonomously.
// The record surfaces in the Queue's Done section as a durable trail of agent actions.
export function dbCreateAmbientActionRecord(intent: Intent): PlanItem {
  const id = uuidv4()
  const created_at = new Date().toISOString()
  const title = intent.target
    ? `${intent.verb ?? 'act'} on ${intent.target}`
    : `${intent.surface ?? 'agent'}:${intent.verb ?? 'action'}`
  getDb()
    .prepare(
      'INSERT INTO plan_items (id, title, detail, status, timing, source, created_at, actions) VALUES (?,?,?,?,?,?,?,?)'
    )
    .run(id, title.slice(0, 200), intent.rationale ?? '', 'done', 'anytime', 'ambient_action', created_at, '[]')
  return dbGetPlanItem(id)!
}

export function dbUpdatePlanItemStatus(id: string, status: PlanItemStatus): void {
  const current = dbGetPlanItem(id)
  if (!current) return
  const timestamp = new Date().toISOString()
  const historyId = uuidv4()
  const fromStatus = current.status
  const db = getDb()
  db.transaction(() => {
    db.prepare('UPDATE plan_items SET status = ? WHERE id = ?').run(status, id)
    db.prepare('INSERT INTO plan_item_history (id, item_id, from_status, to_status, timestamp) VALUES (?,?,?,?,?)')
      .run(historyId, id, fromStatus, status, timestamp)
  })()
}

export function dbDeletePlanItem(id: string): void {
  getDb().prepare('DELETE FROM plan_items WHERE id = ?').run(id)
}

function deserializePlanItem(row: any): PlanItem {
  return {
    ...row,
    actions: safeJsonParse<McpActionRef[]>(row.actions, [])
  }
}

// ─── Badge count ──────────────────────────────────────────────────────────────

export function dbGetBadgeCount(): number {
  const pendingRuns = (
    getDb()
      .prepare("SELECT COUNT(*) as c FROM routine_runs WHERE status = 'pending_response'")
      .get() as any
  ).c as number
  const pendingItems = (
    getDb()
      .prepare("SELECT COUNT(*) as c FROM plan_items WHERE status = 'pending'")
      .get() as any
  ).c as number
  const pendingIntents = (
    getDb()
      .prepare("SELECT COUNT(*) as c FROM intents WHERE status IN ('pending','surfaced')")
      .get() as any
  ).c as number
  return pendingRuns + pendingItems + pendingIntents
}

function safeJsonParse<T>(val: string | null | undefined, fallback: T): T {
  try {
    return val ? JSON.parse(val) : fallback
  } catch {
    return fallback
  }
}

// ─── Signals ─────────────────────────────────────────────────────────────────

export function dbInsertSignal(s: SignalInput): { inserted: boolean; id: string } {
  const id = uuidv4()
  const observed_at = new Date().toISOString()
  const db = getDb()

  // Check if a signal already exists for this (surface, external_id)
  const existing = db
    .prepare('SELECT id, fingerprint FROM signals WHERE surface = ? AND external_id = ?')
    .get(s.surface, s.external_id) as { id: string; fingerprint: string } | undefined

  if (existing) {
    // Always stamp last_seen_at to record that this item was observed in this poll cycle.
    // This happens even when the fingerprint is unchanged — it's the freshness heartbeat.
    if (existing.fingerprint === s.fingerprint) {
      db.prepare('UPDATE signals SET last_seen_at = ? WHERE id = ?').run(observed_at, existing.id)
      return { inserted: false, id: '' }
    }
    // Update the row with the new state — mark unprocessed so triggers re-evaluate it.
    // Wrapped in a transaction so the optional duplicate-delete + update are atomic.
    const updateStmt = db.prepare(
      `UPDATE signals SET fingerprint=?, title=?, body=?, actor=?, url=?, raw=?, occurred_at=?,
       observed_at=?, processed=0, relation=?, directed=?, last_actor=?, due_at=?, last_seen_at=? WHERE id=?`
    )
    const updateArgs = [
      s.fingerprint, s.title, s.body, s.actor, s.url,
      JSON.stringify(s.raw), s.occurred_at ?? null, observed_at,
      s.relation ?? null, s.directed ? 1 : 0, s.last_actor ?? null, s.due_at ?? null,
      observed_at, existing.id
    ] as const
    db.transaction(() => {
      try {
        updateStmt.run(...updateArgs)
      } catch (e: any) {
        if (e?.code !== 'SQLITE_CONSTRAINT_UNIQUE') throw e
        // A sibling row with the same fingerprint exists (leftover from old 3-column constraint).
        // Delete duplicates and retry.
        db.prepare('DELETE FROM signals WHERE surface=? AND external_id=? AND id!=?')
          .run(s.surface, s.external_id, existing.id)
        updateStmt.run(...updateArgs)
      }
    })()
    return { inserted: true, id: existing.id }
  }

  // New signal — insert (last_seen_at = observed_at since this is the first sighting)
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO signals
        (id, surface, kind, external_id, fingerprint, title, body, actor, url, raw, occurred_at, observed_at, processed,
         relation, directed, last_actor, due_at, last_seen_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?)`
    )
    .run(
      id, s.surface, s.kind, s.external_id, s.fingerprint,
      s.title, s.body, s.actor, s.url,
      JSON.stringify(s.raw), s.occurred_at ?? null, observed_at,
      s.relation ?? null, s.directed ? 1 : 0, s.last_actor ?? null, s.due_at ?? null,
      observed_at
    )
  return { inserted: result.changes > 0, id: result.changes > 0 ? id : '' }
}

export function dbGetUnprocessedSignals(limit = 100): Signal[] {
  const rows = getDb()
    .prepare('SELECT * FROM signals WHERE processed = 0 ORDER BY observed_at ASC LIMIT ?')
    .all(limit) as any[]
  return rows.map(deserializeSignal)
}

export function dbMarkSignalsProcessed(ids: string[]): void {
  if (ids.length === 0) return
  const placeholders = ids.map(() => '?').join(',')
  getDb()
    .prepare(`UPDATE signals SET processed = 1 WHERE id IN (${placeholders})`)
    .run(...ids)
}

export function dbGetRecentSignals(surface: string, sinceIso: string, limit = 50): Signal[] {
  const rows = getDb()
    .prepare('SELECT * FROM signals WHERE surface = ? AND observed_at >= ? ORDER BY observed_at DESC LIMIT ?')
    .all(surface, sinceIso, limit) as any[]
  return rows.map(deserializeSignal)
}

export function dbGetRecentSignalsAllSurfaces(sinceIso: string, limit = 200): Signal[] {
  const rows = getDb()
    .prepare('SELECT * FROM signals WHERE observed_at >= ? ORDER BY observed_at DESC LIMIT ?')
    .all(sinceIso, limit) as any[]
  return rows.map(deserializeSignal)
}

export function dbCountSignalsSince(surface: string, kind: string, sinceIso: string): number {
  return (
    getDb()
      .prepare('SELECT COUNT(*) as c FROM signals WHERE surface = ? AND kind = ? AND occurred_at >= ?')
      .get(surface, kind, sinceIso) as any
  ).c as number
}

export function dbGetSignalByExternal(surface: string, externalId: string): Signal | null {
  const row = getDb()
    .prepare('SELECT * FROM signals WHERE surface = ? AND external_id = ? ORDER BY observed_at DESC LIMIT 1')
    .get(surface, externalId) as any
  return row ? deserializeSignal(row) : null
}

/**
 * Returns signals flagged as directed at the owner — used by the synthesis heartbeat
 * to re-evaluate "still waiting on me" items during quiet periods (no new arrivals).
 */
export function dbGetDirectedSignals(limit = 50): Signal[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM signals WHERE directed = 1
       AND relation IN ('review_requested','assigned','mentioned','dm','thread_reply')
       ORDER BY observed_at DESC LIMIT ?`
    )
    .all(limit) as any[]
  return rows.map(deserializeSignal)
}

function deserializeSignal(row: any): Signal {
  // Strip embedding columns — they're internal DB concerns and must not leak over IPC
  const { embedding: _emb, embedding_model: _model, ...rest } = row
  return {
    ...rest,
    processed: row.processed === 1,
    directed: row.directed === 1,
    last_seen_at: row.last_seen_at ?? null,
    raw: safeJsonParse<Record<string, unknown>>(row.raw, {})
  }
}

export function dbSetSignalEmbedding(id: string, embedding: Buffer, model: string): void {
  getDb()
    .prepare('UPDATE signals SET embedding = ?, embedding_model = ? WHERE id = ?')
    .run(embedding, model, id)
}

export function dbGetSignalsWithEmbeddings(
  sinceIso: string,
  limit = 500
): Array<Signal & { embedding: Buffer }> {
  const rows = getDb()
    .prepare(
      'SELECT * FROM signals WHERE embedding IS NOT NULL AND observed_at >= ? ORDER BY observed_at DESC LIMIT ?'
    )
    .all(sinceIso, limit) as any[]
  return rows.map((row) => ({
    ...deserializeSignal(row),
    embedding: row.embedding as Buffer
  }))
}

export function dbGetSignalsMissingEmbeddings(limit = 50): Signal[] {
  const rows = getDb()
    .prepare('SELECT * FROM signals WHERE embedding IS NULL ORDER BY observed_at DESC LIMIT ?')
    .all(limit) as any[]
  return rows.map(deserializeSignal)
}

// ─── Memory embeddings ────────────────────────────────────────────────────────

export function dbSetMemoryEmbedding(id: string, embedding: Buffer, model: string): void {
  getDb()
    .prepare('UPDATE memories SET embedding = ?, embedding_model = ? WHERE id = ?')
    .run(embedding, model, id)
}

/** Returns the raw embedding blob for a memory, or null if not yet computed. */
export function dbGetMemoryEmbedding(id: string): Buffer | null {
  const row = getDb()
    .prepare('SELECT embedding FROM memories WHERE id = ?')
    .get(id) as { embedding: Buffer | null } | undefined
  return row?.embedding ?? null
}

/** Returns active memories that have no stored embedding (for backfill). */
export function dbGetMemoriesMissingEmbeddings(limit = 50): Memory[] {
  const rows = getDb()
    .prepare("SELECT * FROM memories WHERE embedding IS NULL AND status = 'active' ORDER BY created_at DESC LIMIT ?")
    .all(limit) as any[]
  return rows.map(deserializeMemory)
}

// ─── Graph nodes ──────────────────────────────────────────────────────────────

export function dbUpsertNode(type: NodeType, key: string, label: string, attrs?: Record<string, unknown>): GraphNode {
  const now = new Date().toISOString()
  const id = uuidv4()
  getDb()
    .prepare(
      `INSERT INTO graph_nodes (id, type, key, label, attrs, weight, first_seen, last_seen)
       VALUES (?,?,?,?,?,0,?,?)
       ON CONFLICT(type, key) DO UPDATE SET
         label = excluded.label,
         attrs = CASE WHEN excluded.attrs != '{}' THEN excluded.attrs ELSE graph_nodes.attrs END,
         last_seen = excluded.last_seen`
    )
    .run(id, type, key, label, JSON.stringify(attrs ?? {}), now, now)
  return dbGetNode(type, key)!
}

export function dbGetNode(type: NodeType, key: string): GraphNode | null {
  const row = getDb().prepare('SELECT * FROM graph_nodes WHERE type = ? AND key = ?').get(type, key) as any
  return row ? deserializeNode(row) : null
}

export function dbGetNodeById(id: string): GraphNode | null {
  const row = getDb().prepare('SELECT * FROM graph_nodes WHERE id = ?').get(id) as any
  return row ? deserializeNode(row) : null
}

// Hard cap prevents runaway accumulation on frequently-updated nodes. Decay
// (via dbDecayNodes) still reduces weight over time; the cap just stops it
// growing past a point where it dominates every context-packet query.
const GRAPH_NODE_WEIGHT_CAP = 10.0
const GRAPH_EDGE_WEIGHT_CAP = 10.0

export function dbBumpNodeWeight(id: string, delta: number): void {
  const now = new Date().toISOString()
  getDb()
    .prepare('UPDATE graph_nodes SET weight = MIN(weight + ?, ?), last_seen = ? WHERE id = ?')
    .run(delta, GRAPH_NODE_WEIGHT_CAP, now, id)
}

export function dbDecayNodes(halfLifeDays: number, asOfIso?: string): void {
  const asOf = asOfIso ?? new Date().toISOString()
  // exponential decay: weight *= 0.5^(days_since_last_seen / halfLifeDays)
  // SQLite: weight * pow(0.5, (julianday(asOf) - julianday(last_seen)) / halfLifeDays)
  getDb()
    .prepare(
      `UPDATE graph_nodes SET weight = weight * pow(0.5, (julianday(?) - julianday(last_seen)) / ?)
       WHERE weight > 0.001`
    )
    .run(asOf, halfLifeDays)
}

export function dbGetStaleNodes(quietBeforeIso: string, minWeight: number): GraphNode[] {
  const rows = getDb()
    .prepare('SELECT * FROM graph_nodes WHERE last_seen < ? AND weight >= ? ORDER BY weight DESC')
    .all(quietBeforeIso, minWeight) as any[]
  return rows.map(deserializeNode)
}

export function dbGetTopNodesByWeight(limit: number): GraphNode[] {
  const rows = getDb()
    .prepare('SELECT * FROM graph_nodes ORDER BY weight DESC LIMIT ?')
    .all(limit) as any[]
  return rows.map(deserializeNode)
}

function deserializeNode(row: any): GraphNode {
  return {
    ...row,
    attrs: safeJsonParse<Record<string, unknown>>(row.attrs, {})
  }
}

// ─── Graph edges ──────────────────────────────────────────────────────────────

export function dbUpsertEdge(srcId: string, dstId: string, rel: EdgeRel, weightDelta = 1): GraphEdge {
  const now = new Date().toISOString()
  const id = uuidv4()
  getDb()
    .prepare(
      `INSERT INTO graph_edges (id, src_id, dst_id, rel, weight, attrs, first_seen, last_seen)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(src_id, dst_id, rel) DO UPDATE SET
         weight = MIN(graph_edges.weight + ?, ?),
         last_seen = excluded.last_seen`
    )
    .run(id, srcId, dstId, rel, weightDelta, '{}', now, now, weightDelta, GRAPH_EDGE_WEIGHT_CAP)
  const row = getDb().prepare('SELECT * FROM graph_edges WHERE src_id = ? AND dst_id = ? AND rel = ?').get(srcId, dstId, rel) as any
  return deserializeEdge(row)
}

export function dbGetEdgesFrom(srcId: string): GraphEdge[] {
  const rows = getDb().prepare('SELECT * FROM graph_edges WHERE src_id = ?').all(srcId) as any[]
  return rows.map(deserializeEdge)
}

export function dbGetEdgesTo(dstId: string): GraphEdge[] {
  const rows = getDb().prepare('SELECT * FROM graph_edges WHERE dst_id = ?').all(dstId) as any[]
  return rows.map(deserializeEdge)
}

export function dbGetDependencyEdges(): GraphEdge[] {
  const rows = getDb()
    .prepare("SELECT * FROM graph_edges WHERE rel IN ('depends_on','blocked_by','waiting_for')")
    .all() as any[]
  return rows.map(deserializeEdge)
}

export function dbDecayEdges(halfLifeDays: number, asOfIso?: string): void {
  const asOf = asOfIso ?? new Date().toISOString()
  getDb()
    .prepare(
      `UPDATE graph_edges SET weight = weight * pow(0.5, (julianday(?) - julianday(last_seen)) / ?)
       WHERE weight > 0.001`
    )
    .run(asOf, halfLifeDays)
}

function deserializeEdge(row: any): GraphEdge {
  return {
    ...row,
    attrs: safeJsonParse<Record<string, unknown>>(row.attrs, {})
  }
}

export function dbGetAllNodes(): GraphNode[] {
  const rows = getDb().prepare('SELECT * FROM graph_nodes ORDER BY weight DESC').all() as any[]
  return rows.map(deserializeNode)
}

export function dbGetAllEdges(): GraphEdge[] {
  const rows = getDb().prepare('SELECT * FROM graph_edges').all() as any[]
  return rows.map(deserializeEdge)
}

export function dbDeleteNode(id: string): void {
  getDb().prepare('DELETE FROM graph_nodes WHERE id = ?').run(id)
}

export function dbDeleteEdge(id: string): void {
  getDb().prepare('DELETE FROM graph_edges WHERE id = ?').run(id)
}

export function dbDeleteMemory(id: string): void {
  getDb().prepare('DELETE FROM memories WHERE id = ?').run(id)
}

export function dbUpdateMemory(
  id: string,
  update: { content?: string; importance?: number; status?: 'active' | 'superseded' }
): void {
  const sets: string[] = []
  const args: (string | number)[] = []
  if (update.content !== undefined) { sets.push('content = ?'); args.push(update.content) }
  if (update.importance !== undefined) { sets.push('importance = ?'); args.push(update.importance) }
  if (update.status !== undefined) { sets.push('status = ?'); args.push(update.status) }
  if (sets.length === 0) return
  args.push(id)
  getDb().prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...args)
}

// ─── Intents ─────────────────────────────────────────────────────────────────

export function dbCreateIntent(
  obj: IntentObject,
  triggerKind: TriggerKind,
  tier: number,
  contextPacket: Record<string, unknown>
): Intent {
  const id = uuidv4()
  const created_at = new Date().toISOString()
  getDb()
    .prepare(
      `INSERT INTO intents
        (id, type, trigger_kind, confidence, urgency, surface, verb, target, payload, rationale,
         reversibility, required_approval, tier, status, context_packet, created_at, actions)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      id,
      obj.type,
      triggerKind,
      obj.confidence,
      obj.urgency,
      obj.proposed_action.surface,
      obj.proposed_action.verb,
      obj.proposed_action.target,
      JSON.stringify(obj.proposed_action.payload),
      obj.rationale,
      obj.reversibility,
      obj.required_approval ? 1 : 0,
      tier,
      'pending',
      JSON.stringify(contextPacket),
      created_at,
      JSON.stringify(obj.actions ?? [])
    )
  return dbGetIntent(id)!
}

export function dbGetIntent(id: string): Intent | null {
  const row = getDb().prepare('SELECT * FROM intents WHERE id = ?').get(id) as any
  return row ? deserializeIntent(row) : null
}

export function dbGetPendingIntents(): Intent[] {
  const rows = getDb()
    .prepare("SELECT * FROM intents WHERE status IN ('pending','surfaced') ORDER BY created_at DESC")
    .all() as any[]
  return rows.map(deserializeIntent)
}

export function dbGetResolvedIntentsSince(cutoffIso: string): Intent[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM intents
        WHERE status IN ('executed','dismissed','challenged','failed','expired')
          AND resolved_at IS NOT NULL AND resolved_at >= ?
        ORDER BY resolved_at DESC`
    )
    .all(cutoffIso) as any[]
  return rows.map(deserializeIntent)
}

export function dbGetAllIntents(limit = 50): Intent[] {
  const rows = getDb()
    .prepare('SELECT * FROM intents ORDER BY created_at DESC LIMIT ?')
    .all(limit) as any[]
  return rows.map(deserializeIntent)
}

export function dbUpdateIntentStatus(id: string, status: IntentStatus, error?: string): void {
  const resolved_at = new Date().toISOString()
  if (error !== undefined) {
    getDb()
      .prepare('UPDATE intents SET status = ?, resolved_at = ?, error = ? WHERE id = ?')
      .run(status, resolved_at, error, id)
  } else {
    getDb()
      .prepare('UPDATE intents SET status = ?, resolved_at = ? WHERE id = ?')
      .run(status, resolved_at, id)
  }
}

export function dbSetIntentChallengeReason(id: string, reason: string): void {
  getDb().prepare('UPDATE intents SET challenge_reason = ? WHERE id = ?').run(reason, id)
}

export function dbUpdateIntentPayload(id: string, payload: Record<string, unknown>): void {
  getDb()
    .prepare('UPDATE intents SET payload = ? WHERE id = ?')
    .run(JSON.stringify(payload), id)
}

export function dbUpdateIntentActions(id: string, actions: McpActionRef[]): void {
  getDb()
    .prepare('UPDATE intents SET actions = ? WHERE id = ?')
    .run(JSON.stringify(actions), id)
}

function deserializeIntent(row: any): Intent {
  return {
    ...row,
    required_approval: row.required_approval === 1,
    payload: safeJsonParse<Record<string, unknown>>(row.payload, {}),
    context_packet: safeJsonParse<Record<string, unknown>>(row.context_packet, {}),
    challenge_reason: row.challenge_reason ?? null,
    actions: safeJsonParse<McpActionRef[]>(row.actions, [])
  }
}

// ─── Autonomy policy ──────────────────────────────────────────────────────────

export function dbGetPolicy(actionType: string): AutonomyPolicy | null {
  const row = getDb().prepare('SELECT * FROM autonomy_policy WHERE action_type = ?').get(actionType) as any
  return row ? deserializePolicy(row) : null
}

export function dbGetAllPolicies(): AutonomyPolicy[] {
  const rows = getDb().prepare('SELECT * FROM autonomy_policy ORDER BY action_type ASC').all() as any[]
  return rows.map(deserializePolicy)
}

export function dbUpsertPolicy(actionType: string, fields: Partial<Omit<AutonomyPolicy, 'action_type'>>): AutonomyPolicy {
  const now = new Date().toISOString()
  const existing = dbGetPolicy(actionType)
  if (!existing) {
    const defaults = { tier: 2, tier_locked: false, approvals: 0, consecutive_approvals: 0, challenges: 0, dismissals: 0, executions: 0 }
    const merged = { ...defaults, ...fields }
    getDb()
      .prepare(
        `INSERT INTO autonomy_policy
          (action_type, tier, tier_locked, approvals, consecutive_approvals, challenges, dismissals, executions, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(
        actionType,
        merged.tier,
        merged.tier_locked ? 1 : 0,
        merged.approvals,
        merged.consecutive_approvals,
        merged.challenges,
        merged.dismissals,
        merged.executions,
        now
      )
  } else {
    const sets: string[] = ['updated_at = ?']
    const vals: unknown[] = [now]
    if (fields.tier !== undefined) { sets.push('tier = ?'); vals.push(fields.tier) }
    if (fields.tier_locked !== undefined) { sets.push('tier_locked = ?'); vals.push(fields.tier_locked ? 1 : 0) }
    if (fields.approvals !== undefined) { sets.push('approvals = ?'); vals.push(fields.approvals) }
    if (fields.consecutive_approvals !== undefined) { sets.push('consecutive_approvals = ?'); vals.push(fields.consecutive_approvals) }
    if (fields.challenges !== undefined) { sets.push('challenges = ?'); vals.push(fields.challenges) }
    if (fields.dismissals !== undefined) { sets.push('dismissals = ?'); vals.push(fields.dismissals) }
    if (fields.executions !== undefined) { sets.push('executions = ?'); vals.push(fields.executions) }
    vals.push(actionType)
    getDb().prepare(`UPDATE autonomy_policy SET ${sets.join(', ')} WHERE action_type = ?`).run(...vals)
  }
  return dbGetPolicy(actionType)!
}

export function dbRecordPolicyOutcome(
  actionType: string,
  outcome: 'approval' | 'challenge' | 'dismissal' | 'execution'
): AutonomyPolicy {
  const now = new Date().toISOString()
  // Ensure row exists
  dbUpsertPolicy(actionType, {})
  const db = getDb()

  if (outcome === 'approval') {
    // Increment cumulative approvals and consecutive run
    db.prepare(
      `UPDATE autonomy_policy SET approvals = approvals + 1,
       consecutive_approvals = consecutive_approvals + 1, updated_at = ? WHERE action_type = ?`
    ).run(now, actionType)
  } else if (outcome === 'challenge') {
    // Reset the consecutive streak — challenge breaks trust accumulation
    db.prepare(
      `UPDATE autonomy_policy SET challenges = challenges + 1,
       consecutive_approvals = 0, updated_at = ? WHERE action_type = ?`
    ).run(now, actionType)
  } else if (outcome === 'dismissal') {
    // Reset consecutive streak on dismissal too
    db.prepare(
      `UPDATE autonomy_policy SET dismissals = dismissals + 1,
       consecutive_approvals = 0, updated_at = ? WHERE action_type = ?`
    ).run(now, actionType)
  } else {
    db.prepare(
      `UPDATE autonomy_policy SET executions = executions + 1, updated_at = ? WHERE action_type = ?`
    ).run(now, actionType)
  }

  return dbGetPolicy(actionType)!
}

function deserializePolicy(row: any): AutonomyPolicy {
  return {
    ...row,
    tier: row.tier as Tier,
    tier_locked: row.tier_locked === 1,
    consecutive_approvals: row.consecutive_approvals ?? 0
  }
}

// ─── Action log ───────────────────────────────────────────────────────────────

export function dbAppendActionLog(entry: Omit<ActionLogEntry, 'id'>): void {
  const id = uuidv4()
  getDb()
    .prepare(
      `INSERT INTO action_log (id, intent_id, event, action_type, tier, detail, created_at)
       VALUES (?,?,?,?,?,?,?)`
    )
    .run(
      id,
      entry.intent_id ?? null,
      entry.event,
      entry.action_type,
      entry.tier ?? null,
      JSON.stringify(entry.detail),
      entry.created_at
    )
}

export function dbGetActionLog(limit = 100): ActionLogEntry[] {
  const rows = getDb()
    .prepare('SELECT * FROM action_log ORDER BY created_at DESC LIMIT ?')
    .all(limit) as any[]
  return rows.map((row) => ({
    ...row,
    detail: safeJsonParse<Record<string, unknown>>(row.detail, {})
  }))
}

// ─── Maintenance / retention ──────────────────────────────────────────────────
// Prune tables that accumulate unboundedly. Called periodically (e.g. once per day).

const SIGNAL_RETAIN_DAYS = 30
const ACTION_LOG_RETAIN_DAYS = 90
const GRAPH_NODE_MIN_WEIGHT = 0.001 // delete nodes that have decayed to essentially zero

export function dbRunMaintenance(): void {
  const db = getDb()
  const signalCutoff = new Date(Date.now() - SIGNAL_RETAIN_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const logCutoff = new Date(Date.now() - ACTION_LOG_RETAIN_DAYS * 24 * 60 * 60 * 1000).toISOString()

  const deletedSignals = db.prepare('DELETE FROM signals WHERE observed_at < ?').run(signalCutoff).changes
  const deletedLog = db.prepare('DELETE FROM action_log WHERE created_at < ?').run(logCutoff).changes
  // Prune fully-decayed graph nodes (and their edges via CASCADE)
  const deletedNodes = db
    .prepare('DELETE FROM graph_nodes WHERE weight < ?')
    .run(GRAPH_NODE_MIN_WEIGHT).changes

  console.log(
    `[db] maintenance: removed ${deletedSignals} signals, ${deletedLog} log entries, ${deletedNodes} graph nodes`
  )
}

// ─── Timeline ─────────────────────────────────────────────────────────────────

export function dbLinkNodeSignal(
  nodeId: string,
  signalId: string,
  surface: string,
  summary: string,
  occurredAt: string | null,
  observedAt: string
): void {
  const id = uuidv4()
  getDb()
    .prepare(
      `INSERT INTO node_signals (id, node_id, signal_id, surface, summary, occurred_at, observed_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(node_id, signal_id) DO UPDATE SET
         summary     = excluded.summary,
         occurred_at = excluded.occurred_at,
         observed_at = excluded.observed_at`
    )
    .run(id, nodeId, signalId, surface, summary, occurredAt ?? null, observedAt)
}

export function dbGetNodeTimeline(nodeId: string, limit = 50): NodeSignalLink[] {
  const rows = getDb()
    .prepare('SELECT * FROM node_signals WHERE node_id = ? ORDER BY observed_at ASC LIMIT ?')
    .all(nodeId, limit) as any[]
  return rows.map(deserializeNodeSignalLink)
}

export function dbGetNodeFirstSeen(nodeId: string): string | null {
  // Use the earliest known event time; fall back to ingestion time when occurred_at is null.
  const row = getDb()
    .prepare('SELECT MIN(COALESCE(occurred_at, observed_at)) as first FROM node_signals WHERE node_id = ?')
    .get(nodeId) as { first: string | null } | undefined
  return row?.first ?? null
}

function deserializeNodeSignalLink(row: any): NodeSignalLink {
  return { ...row }
}

// ─── Memories ─────────────────────────────────────────────────────────────────

export function dbCreateMemory(input: MemoryInput): Memory {
  const id = uuidv4()
  const created_at = new Date().toISOString()
  getDb()
    .prepare(
      `INSERT INTO memories
        (id, content, type, enforcement, confidence, importance, surface, node_id, status, superseded_by, created_at, last_accessed)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      id,
      input.content,
      input.type,
      input.enforcement ?? 'soft',
      input.confidence,
      input.importance,
      input.surface,
      input.node_id ?? null,
      'active',
      null,
      created_at,
      null
    )
  return dbGetMemory(id)!
}

function dbGetMemory(id: string): Memory | null {
  const row = getDb().prepare('SELECT * FROM memories WHERE id = ?').get(id) as any
  return row ? deserializeMemory(row) : null
}

export function dbGetActiveMemories(limit = 10): Memory[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM memories WHERE status = 'active' ORDER BY importance DESC, created_at DESC LIMIT ?"
    )
    .all(limit) as any[]
  return rows.map(deserializeMemory)
}

/**
 * Returns ALL active memories with enforcement='hard', ordered by importance.
 * Hard memories are NOT subject to the context-packet cap; they are injected as
 * trusted standing directives into inference system prompts.
 */
export function dbGetActiveHardMemories(): Memory[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM memories WHERE status = 'active' AND enforcement = 'hard' ORDER BY importance DESC, created_at DESC"
    )
    .all() as any[]
  return rows.map(deserializeMemory)
}

export function dbGetAllMemories(): Memory[] {
  const rows = getDb()
    .prepare('SELECT * FROM memories ORDER BY created_at ASC')
    .all() as any[]
  return rows.map(deserializeMemory)
}

export function dbGetMemoriesForNode(nodeId: string): Memory[] {
  const rows = getDb()
    .prepare("SELECT * FROM memories WHERE node_id = ? AND status = 'active'")
    .all(nodeId) as any[]
  return rows.map(deserializeMemory)
}

export function dbSupersedeMemory(oldId: string, newId: string): void {
  getDb()
    .prepare("UPDATE memories SET status = 'superseded', superseded_by = ? WHERE id = ?")
    .run(newId, oldId)
}

export function dbTouchMemoryAccessed(ids: string[]): void {
  if (ids.length === 0) return
  const now = new Date().toISOString()
  const placeholders = ids.map(() => '?').join(',')
  getDb()
    .prepare(`UPDATE memories SET last_accessed = ? WHERE id IN (${placeholders})`)
    .run(now, ...ids)
}

function deserializeMemory(row: any): Memory {
  // Strip embedding columns — internal DB concerns, must not leak over IPC
  const { embedding: _emb, embedding_model: _model, ...rest } = row
  return {
    ...rest,
    enforcement: row.enforcement === 'hard' ? 'hard' : 'soft'
  }
}

// ─── Fingerprint helper ───────────────────────────────────────────────────────

export function computeFingerprint(surface: string, externalId: string, changeFields: Record<string, unknown>): string {
  return createHash('sha256')
    .update(`${surface}|${externalId}|${JSON.stringify(changeFields)}`)
    .digest('hex')
    .slice(0, 16)
}

// ─── Usage tracking ───────────────────────────────────────────────────────────

export function dbInsertUsage(
  e: Omit<UsageEvent, 'id' | 'created_at'>
): void {
  const id = uuidv4()
  const created_at = new Date().toISOString()
  getDb()
    .prepare(
      `INSERT INTO usage_events
        (id, source, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost_usd, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    )
    .run(
      id,
      e.source,
      e.model,
      e.input_tokens,
      e.output_tokens,
      e.cache_creation_tokens,
      e.cache_read_tokens,
      e.cost_usd,
      created_at
    )
}

function usageSince(range: string): string | undefined {
  if (range === 'all') return undefined
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
}

export function dbGetUsageSummary(range: string): UsageSummary {
  const since = usageSince(range)
  const sql = since
    ? `SELECT
         COALESCE(SUM(input_tokens), 0)          AS total_input,
         COALESCE(SUM(output_tokens), 0)         AS total_output,
         COALESCE(SUM(cache_creation_tokens), 0) AS total_cache_creation,
         COALESCE(SUM(cache_read_tokens), 0)     AS total_cache_read,
         COALESCE(SUM(cost_usd), 0)              AS total_cost,
         COUNT(*)                                AS call_count
       FROM usage_events WHERE created_at >= ?`
    : `SELECT
         COALESCE(SUM(input_tokens), 0)          AS total_input,
         COALESCE(SUM(output_tokens), 0)         AS total_output,
         COALESCE(SUM(cache_creation_tokens), 0) AS total_cache_creation,
         COALESCE(SUM(cache_read_tokens), 0)     AS total_cache_read,
         COALESCE(SUM(cost_usd), 0)              AS total_cost,
         COUNT(*)                                AS call_count
       FROM usage_events`
  const row = (since
    ? getDb().prepare(sql).get(since)
    : getDb().prepare(sql).get()) as any
  return {
    total_input: row.total_input ?? 0,
    total_output: row.total_output ?? 0,
    total_cache_creation: row.total_cache_creation ?? 0,
    total_cache_read: row.total_cache_read ?? 0,
    total_cost: row.total_cost ?? 0,
    call_count: row.call_count ?? 0
  }
}

export function dbGetUsageByDay(range: string): UsageDailyPoint[] {
  const since = usageSince(range)
  const sql = since
    ? `SELECT
         date(created_at) AS day,
         SUM(input_tokens)  AS input_tokens,
         SUM(output_tokens) AS output_tokens,
         SUM(cost_usd)      AS cost,
         COUNT(*)           AS calls
       FROM usage_events WHERE created_at >= ?
       GROUP BY day ORDER BY day ASC`
    : `SELECT
         date(created_at) AS day,
         SUM(input_tokens)  AS input_tokens,
         SUM(output_tokens) AS output_tokens,
         SUM(cost_usd)      AS cost,
         COUNT(*)           AS calls
       FROM usage_events
       GROUP BY day ORDER BY day ASC`
  const rows = (since
    ? getDb().prepare(sql).all(since)
    : getDb().prepare(sql).all()) as any[]
  return rows.map((r) => ({
    day: r.day,
    input_tokens: r.input_tokens ?? 0,
    output_tokens: r.output_tokens ?? 0,
    cost: r.cost ?? 0,
    calls: r.calls ?? 0
  }))
}

export function dbGetUsageBySource(range: string): UsageBreakdownRow[] {
  const since = usageSince(range)
  const sql = since
    ? `SELECT
         source AS key,
         SUM(input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens) AS tokens,
         SUM(cost_usd) AS cost,
         COUNT(*) AS calls
       FROM usage_events WHERE created_at >= ?
       GROUP BY source ORDER BY cost DESC`
    : `SELECT
         source AS key,
         SUM(input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens) AS tokens,
         SUM(cost_usd) AS cost,
         COUNT(*) AS calls
       FROM usage_events
       GROUP BY source ORDER BY cost DESC`
  const rows = (since
    ? getDb().prepare(sql).all(since)
    : getDb().prepare(sql).all()) as any[]
  return rows.map((r) => ({ key: r.key, tokens: r.tokens ?? 0, cost: r.cost ?? 0, calls: r.calls ?? 0 }))
}

export function dbGetUsageByModel(range: string): UsageBreakdownRow[] {
  const since = usageSince(range)
  const sql = since
    ? `SELECT
         model AS key,
         SUM(input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens) AS tokens,
         SUM(cost_usd) AS cost,
         COUNT(*) AS calls
       FROM usage_events WHERE created_at >= ?
       GROUP BY model ORDER BY cost DESC`
    : `SELECT
         model AS key,
         SUM(input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens) AS tokens,
         SUM(cost_usd) AS cost,
         COUNT(*) AS calls
       FROM usage_events
       GROUP BY model ORDER BY cost DESC`
  const rows = (since
    ? getDb().prepare(sql).all(since)
    : getDb().prepare(sql).all()) as any[]
  return rows.map((r) => ({ key: r.key, tokens: r.tokens ?? 0, cost: r.cost ?? 0, calls: r.calls ?? 0 }))
}

export function dbGetRecentUsage(limit = 30, range = 'all'): UsageEvent[] {
  const since = usageSince(range)
  const rows = since
    ? (getDb()
        .prepare('SELECT * FROM usage_events WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?')
        .all(since, limit) as any[])
    : (getDb()
        .prepare('SELECT * FROM usage_events ORDER BY created_at DESC LIMIT ?')
        .all(limit) as any[])
  return rows.map((r) => ({
    id: r.id,
    source: r.source as UsageSource,
    model: r.model,
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
    cache_creation_tokens: r.cache_creation_tokens,
    cache_read_tokens: r.cache_read_tokens,
    cost_usd: r.cost_usd,
    created_at: r.created_at
  }))
}

// ─── Check-ins ────────────────────────────────────────────────────────────────

function deserializeCheckIn(row: any): CheckIn {
  return {
    id: row.id,
    status: row.status as CheckInStatus,
    trigger: row.trigger as 'manual' | 'scheduled',
    started_at: row.started_at,
    completed_at: row.completed_at ?? null,
    briefing: row.briefing ?? '',
    extraction_summary: row.extraction_summary ?? null
  }
}

export function dbCreateCheckIn(trigger: 'manual' | 'scheduled'): CheckIn {
  const id = uuidv4()
  const started_at = new Date().toISOString()
  getDb()
    .prepare('INSERT INTO check_ins (id, status, trigger, started_at, briefing) VALUES (?,?,?,?,?)')
    .run(id, 'active', trigger, started_at, '')
  return dbGetCheckIn(id)!
}

export function dbGetCheckIn(id: string): CheckIn | null {
  const row = getDb().prepare('SELECT * FROM check_ins WHERE id = ?').get(id) as any
  return row ? deserializeCheckIn(row) : null
}

export function dbGetActiveCheckIn(): CheckIn | null {
  const row = getDb().prepare("SELECT * FROM check_ins WHERE status = 'active' ORDER BY started_at DESC LIMIT 1").get() as any
  return row ? deserializeCheckIn(row) : null
}

export function dbGetCheckIns(limit = 30): CheckIn[] {
  const rows = getDb()
    .prepare('SELECT * FROM check_ins ORDER BY started_at DESC LIMIT ?')
    .all(limit) as any[]
  return rows.map(deserializeCheckIn)
}

export function dbUpdateCheckIn(
  id: string,
  fields: Partial<{
    status: CheckInStatus
    completed_at: string
    briefing: string
    extraction_summary: string
  }>
): void {
  const keys = Object.keys(fields)
  if (keys.length === 0) return
  const sets = keys.map((k) => `${k} = ?`).join(', ')
  const vals = [...Object.values(fields), id]
  getDb().prepare(`UPDATE check_ins SET ${sets} WHERE id = ?`).run(...vals)
}

export function dbAddCheckInMessage(checkinId: string, role: string, content: string): ChatMessage {
  const id = uuidv4()
  const timestamp = new Date().toISOString()
  getDb()
    .prepare('INSERT INTO checkin_messages (id, checkin_id, role, content, timestamp) VALUES (?,?,?,?,?)')
    .run(id, checkinId, role, content, timestamp)
  return { id, role: role as any, content, timestamp }
}

export function dbGetCheckInThread(checkinId: string): ChatMessage[] {
  const rows = getDb()
    .prepare('SELECT * FROM checkin_messages WHERE checkin_id = ? ORDER BY timestamp ASC')
    .all(checkinId) as any[]
  return rows.map((r) => ({ id: r.id, role: r.role, content: r.content, timestamp: r.timestamp }))
}
