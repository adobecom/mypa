import BetterSqlite3 from 'better-sqlite3'
import { join } from 'path'
import { app } from 'electron'
import { mkdirSync } from 'fs'
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
  RoutineAction
} from '@shared/types'

let _db: BetterSqlite3.Database | null = null

export function getDb(): BetterSqlite3.Database {
  if (!_db) throw new Error('Database not initialized')
  return _db
}

export function initDb(): void {
  const dataDir = join(app.getPath('home'), '.mypa')
  mkdirSync(dataDir, { recursive: true })
  const dbPath = join(dataDir, 'data.db')
  _db = new BetterSqlite3(dbPath)
  initSchema(_db)
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
  return { ...row }
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

export function dbAddPlanMessage(itemId: string, role: string, content: string): ChatMessage {
  const id = uuidv4()
  const timestamp = new Date().toISOString()
  getDb()
    .prepare('INSERT INTO plan_item_threads (id, item_id, role, content, timestamp) VALUES (?,?,?,?,?)')
    .run(id, itemId, role, content, timestamp)
  return { id, role: role as any, content, timestamp }
}

export function dbGetPlanThread(itemId: string): ChatMessage[] {
  const rows = getDb()
    .prepare('SELECT * FROM plan_item_threads WHERE item_id = ? ORDER BY timestamp ASC')
    .all(itemId) as any[]
  return rows.map((r) => ({ id: r.id, role: r.role, content: r.content, timestamp: r.timestamp }))
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

export function dbUpdatePlanItemStatus(id: string, status: PlanItemStatus): void {
  const current = dbGetPlanItem(id)
  if (!current) return
  const timestamp = new Date().toISOString()
  getDb().prepare('UPDATE plan_items SET status = ? WHERE id = ?').run(status, id)
  getDb()
    .prepare('INSERT INTO plan_item_history (id, item_id, from_status, to_status, timestamp) VALUES (?,?,?,?,?)')
    .run(uuidv4(), id, current.status, status, timestamp)
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
  return pendingRuns + pendingItems
}

function safeJsonParse<T>(val: string | null | undefined, fallback: T): T {
  try {
    return val ? JSON.parse(val) : fallback
  } catch {
    return fallback
  }
}
