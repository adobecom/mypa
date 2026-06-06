#!/usr/bin/env node
/**
 * seed-graph.mjs — one-time GitHub seed for the mypa knowledge graph
 *
 * Fetches open PRs and issues you're involved with via the `gh` CLI and writes
 * them directly into ~/.mypa/data.db using pipeline-identical key formats so
 * future organic polls deduplicate onto the same nodes rather than duplicating.
 *
 * Usage:  node scripts/seed-graph.mjs
 * Prereq: gh CLI authed, better-sqlite3 built (npm run postinstall).
 *
 * This file is a throwaway seed tool — delete after use.
 */

import { execSync } from 'child_process'
import { createHash, randomBytes } from 'crypto'
import { createRequire } from 'module'
import { homedir } from 'os'
import { join } from 'path'

const require = createRequire(import.meta.url)

// ─── DB setup ─────────────────────────────────────────────────────────────────

const DB_PATH = join(homedir(), '.mypa', 'data.db')
let Database
try {
  // Try to load from the app's own node_modules first (pre-built native module)
  Database = require('../node_modules/better-sqlite3')
} catch {
  console.error('better-sqlite3 not found. Run: npm run postinstall')
  process.exit(1)
}

const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

// ─── Helpers ──────────────────────────────────────────────────────────────────

function uuid() {
  const bytes = randomBytes(16)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`
}

function fingerprint(surface, externalId, changeFields) {
  return createHash('sha256')
    .update(`${surface}|${externalId}|${JSON.stringify(changeFields)}`)
    .digest('hex')
    .slice(0, 16)
}

function ghJson(args) {
  try {
    const out = execSync(`gh ${args}`, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
    return JSON.parse(out)
  } catch (e) {
    console.warn(`[gh] failed: gh ${args}`, e.message)
    return []
  }
}

// ─── Prepared statements (mirrors db/index.ts SQL exactly) ───────────────────

const stmtGetSignal = db.prepare('SELECT id, fingerprint FROM signals WHERE surface = ? AND external_id = ?')

const stmtInsertSignal = db.prepare(`
  INSERT OR IGNORE INTO signals
    (id, surface, kind, external_id, fingerprint, title, body, actor, url, raw, occurred_at, observed_at, processed)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0)
`)

const stmtUpdateSignal = db.prepare(`
  UPDATE signals SET fingerprint=?, title=?, body=?, actor=?, url=?, raw=?, occurred_at=?,
    observed_at=?, processed=0 WHERE id=?
`)

const stmtUpsertNode = db.prepare(`
  INSERT INTO graph_nodes (id, type, key, label, attrs, weight, first_seen, last_seen)
  VALUES (?,?,?,?,?,0,?,?)
  ON CONFLICT(type, key) DO UPDATE SET
    label = excluded.label,
    attrs = CASE WHEN excluded.attrs != '{}' THEN excluded.attrs ELSE graph_nodes.attrs END,
    last_seen = excluded.last_seen
`)

const stmtGetNode = db.prepare('SELECT id FROM graph_nodes WHERE type = ? AND key = ?')

const stmtBumpWeight = db.prepare('UPDATE graph_nodes SET weight = weight + ?, last_seen = ? WHERE id = ?')

const stmtUpsertEdge = db.prepare(`
  INSERT INTO graph_edges (id, src_id, dst_id, rel, weight, attrs, first_seen, last_seen)
  VALUES (?,?,?,?,?,?,?,?)
  ON CONFLICT(src_id, dst_id, rel) DO UPDATE SET
    weight = graph_edges.weight + ?,
    last_seen = excluded.last_seen
`)

const stmtLinkNodeSignal = db.prepare(`
  INSERT INTO node_signals (id, node_id, signal_id, surface, summary, occurred_at, observed_at)
  VALUES (?,?,?,?,?,?,?)
  ON CONFLICT(node_id, signal_id) DO UPDATE SET
    summary     = excluded.summary,
    occurred_at = excluded.occurred_at,
    observed_at = excluded.observed_at
`)

// ─── Core write operations ────────────────────────────────────────────────────

function upsertNode(type, key, label, attrs) {
  const now = new Date().toISOString()
  const id = uuid()
  stmtUpsertNode.run(id, type, key, label, JSON.stringify(attrs ?? {}), now, now)
  return stmtGetNode.get(type, key).id
}

function bumpWeight(nodeId, delta) {
  stmtBumpWeight.run(delta, new Date().toISOString(), nodeId)
}

function upsertEdge(srcId, dstId, rel, weightDelta = 0.5) {
  const now = new Date().toISOString()
  const id = uuid()
  stmtUpsertEdge.run(id, srcId, dstId, rel, weightDelta, '{}', now, now, weightDelta)
}

function insertSignal({ surface, kind, external_id, fp, title, body, actor, url, raw, occurred_at }) {
  const now = new Date().toISOString()
  const existing = stmtGetSignal.get(surface, external_id)

  if (existing) {
    if (existing.fingerprint === fp) return { inserted: false, id: existing.id }
    stmtUpdateSignal.run(fp, title, body, actor, url, JSON.stringify(raw), occurred_at ?? null, now, existing.id)
    return { inserted: true, id: existing.id }
  }

  const id = uuid()
  const result = stmtInsertSignal.run(id, surface, kind, external_id, fp, title, body, actor, url,
    JSON.stringify(raw), occurred_at ?? null, now)
  return { inserted: result.changes > 0, id: result.changes > 0 ? id : '' }
}

function linkNodeSignal(nodeId, signalId, surface, summary, occurredAt) {
  const now = new Date().toISOString()
  stmtLinkNodeSignal.run(uuid(), nodeId, signalId, surface, summary, occurredAt ?? null, now)
}

// ─── Ingest one item (mirrors ingestSignalIntoGraph in memory-graph.ts) ───────

function ingest(signal) {
  const { id: signalId, inserted } = insertSignal(signal)
  if (!signalId) return false // unchanged fingerprint

  // Task node — key matches pipeline: `${surface}:${kind}:${external_id}`
  const taskKey = `${signal.surface}:${signal.kind}:${signal.external_id}`
  const taskId = upsertNode('task', taskKey, signal.title.slice(0, 120), {
    url: signal.url, surface: signal.surface, kind: signal.kind
  })
  bumpWeight(taskId, 1.0)
  linkNodeSignal(taskId, signalId, signal.surface, signal.title.slice(0, 120), signal.occurred_at)

  // Project node
  const repoFullName = signal.raw?.repository?.full_name
  if (repoFullName) {
    const projectKey = `github:repo:${repoFullName}`
    const projectId = upsertNode('project', projectKey, repoFullName)
    bumpWeight(projectId, 0.5)
    upsertEdge(taskId, projectId, 'working_on')
  }

  // Person node (actor)
  if (signal.actor) {
    const personKey = `github:person:${signal.actor}`
    const personId = upsertNode('person', personKey, signal.actor, { surface: signal.surface })
    bumpWeight(personId, 0.3)
    upsertEdge(personId, taskId, 'working_on')
  }

  // blocked_by from PR body (mirrors deriveEdgesFromRaw — same pre-existing key inconsistency)
  const body = signal.raw?.body ?? signal.body ?? ''
  const blockMatch = String(body).match(/blocked\s+by\s+#(\d+)/i)
  if (blockMatch) {
    const blockerKey = `${signal.surface}:pull_request:${blockMatch[1]}`
    const blockerRow = stmtGetNode.get('task', blockerKey)
    if (blockerRow) upsertEdge(taskId, blockerRow.id, 'blocked_by')
  }

  return inserted
}

// ─── Fetch from gh CLI ────────────────────────────────────────────────────────

function fetchItems() {
  const items = []

  console.log('Fetching open PRs involving @me…')
  const prs = ghJson('search prs --involves=@me --state=open --json number,title,url,repository,author,body,updatedAt,createdAt,state --limit 30')
  for (const pr of prs) {
    items.push({ ghItem: pr, kind: 'pull_request' })
  }

  console.log('Fetching open issues involving @me…')
  const issues = ghJson('search issues --involves=@me --state=open --json number,title,url,repository,author,body,updatedAt,createdAt,state --limit 20')
  for (const issue of issues) {
    items.push({ ghItem: issue, kind: 'issue' })
  }

  return items
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const items = fetchItems()
console.log(`\nFetched ${items.length} items (PRs + issues). Seeding into ${DB_PATH}…\n`)

let inserted = 0
let updated = 0
let skipped = 0

const seedAll = db.transaction(() => {
  for (const { ghItem: r, kind } of items) {
    const num = String(r.number ?? '')
    if (!num) { skipped++; continue }

    const external_id = `${kind}:${num}`
    const title = String(r.title ?? '').trim()
    const actor = String(r.author?.login ?? '')
    const url = String(r.url ?? '')
    const occurred_at = r.updatedAt ?? r.createdAt ?? null
    const rawBody = String(r.body ?? '').slice(0, 500)

    // Normalize raw to match what scrubRaw keeps: number, id, html_url, url, state,
    // updated_at, created_at, repository (with full_name), user (with login)
    const rawStored = {
      number: r.number,
      html_url: url,
      url,
      state: r.state,
      updated_at: r.updatedAt,
      created_at: r.createdAt,
      body: rawBody,
      repository: {
        full_name: r.repository?.nameWithOwner ?? null
      },
      user: { login: actor }
    }

    const changeFields = {
      state: r.state,
      updated_at: r.updatedAt,
      comments: r.comments ?? 0,
      assignees: (r.assignees ?? []).map((a) => a.login)
    }

    const fp = fingerprint('github', external_id, changeFields)

    const signal = {
      surface: 'github',
      kind,
      external_id,
      fp,
      title: title || `${kind} #${num}`,
      body: rawBody,
      actor,
      url,
      raw: rawStored,
      occurred_at
    }

    const wasInserted = ingest(signal)
    if (wasInserted === true) inserted++
    else if (wasInserted === false) updated++ // fingerprint changed
    else skipped++ // unchanged fingerprint
  }
})

seedAll()

// Summary
const nodeCount = db.prepare('SELECT COUNT(*) as c FROM graph_nodes').get().c
const edgeCount = db.prepare('SELECT COUNT(*) as c FROM graph_edges').get().c
const signalCount = db.prepare("SELECT COUNT(*) as c FROM signals WHERE surface='github'").get().c

db.pragma('wal_checkpoint(TRUNCATE)')
db.close()

console.log(`Done.`)
console.log(`  Signals: ${inserted} new · ${updated} updated · ${skipped} unchanged`)
console.log(`  Graph:   ${nodeCount} nodes · ${edgeCount} edges`)
console.log(`  Total GitHub signals in DB: ${signalCount}`)
console.log(`\nOpen mypa → Memory tab → Refresh to see the graph.`)
