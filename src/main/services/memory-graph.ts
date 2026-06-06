import {
  dbUpsertNode,
  dbGetNode,
  dbGetNodeById,
  dbBumpNodeWeight,
  dbDecayNodes,
  dbDecayEdges,
  dbUpsertEdge,
  dbGetEdgesFrom,
  dbGetEdgesTo,
  dbGetStaleNodes,
  dbGetTopNodesByWeight,
  dbGetRecentSignals,
  dbLinkNodeSignal,
  dbGetSignalsWithEmbeddings,
  dbGetActiveMemories,
  dbTouchMemoryAccessed
} from '../db/index'
import { readConfig } from './config'
import { embedText, cosineSim, blobToFloat } from './embeddings'
import type { Signal, GraphNode, GraphEdge, TriggerKind, Memory } from '@shared/types'

export interface ContextPacket {
  triggerKind: TriggerKind
  focusNodes: GraphNode[]
  relatedEdges: GraphEdge[]
  recentSignals: Signal[]
  topByWeight: GraphNode[]
  semanticSignals: Signal[]
  memories: Memory[]
}

// Weight increments per event
const WEIGHT_SIGNAL = 1.0
const WEIGHT_EDGE = 0.5

// ─── Signal ingestion into graph ──────────────────────────────────────────────

export function ingestSignalIntoGraph(signal: Signal): void {
  const now = signal.observed_at

  // Upsert the "task" node (PR, issue, message)
  const taskKey = `${signal.surface}:${signal.kind}:${signal.external_id}`
  const taskNode = dbUpsertNode('task', taskKey, signal.title.slice(0, 120), {
    url: signal.url,
    surface: signal.surface,
    kind: signal.kind
  })
  dbBumpNodeWeight(taskNode.id, WEIGHT_SIGNAL)
  // Timeline: link this signal to the task node so we can reconstruct how it evolved
  dbLinkNodeSignal(taskNode.id, signal.id, signal.surface, signal.title.slice(0, 120), signal.occurred_at, now)

  // Upsert the project / channel node
  const projectKey = deriveProjectKey(signal)
  if (projectKey) {
    const projectLabel = deriveProjectLabel(signal)
    const projectNode = dbUpsertNode('project', projectKey, projectLabel)
    dbBumpNodeWeight(projectNode.id, WEIGHT_SIGNAL * 0.5)
    // Edge: task working_on project
    dbUpsertEdge(taskNode.id, projectNode.id, 'working_on', WEIGHT_EDGE)
  }

  // Upsert the actor (person) node
  if (signal.actor) {
    const personKey = `${signal.surface}:person:${signal.actor}`
    const personNode = dbUpsertNode('person', personKey, signal.actor, { surface: signal.surface })
    dbBumpNodeWeight(personNode.id, WEIGHT_SIGNAL * 0.3)
    // Edge: person working_on task
    dbUpsertEdge(personNode.id, taskNode.id, 'working_on', WEIGHT_EDGE)
  }

  // Derive dependency edges from raw signal fields
  deriveEdgesFromRaw(signal, taskNode.id)
}

function deriveProjectKey(signal: Signal): string | null {
  if (signal.surface === 'github') {
    const repo = (signal.raw as any)?.repository?.full_name ?? (signal.raw as any)?.repo ?? null
    return repo ? `github:repo:${repo}` : null
  }
  if (signal.surface === 'jira') {
    const key = signal.external_id.split('-')[0] // "PROJ-123" → "PROJ"
    return key ? `jira:project:${key}` : null
  }
  if (signal.surface === 'slack') {
    const channel = (signal.raw as any)?.channel ?? null
    return channel ? `slack:channel:${channel}` : null
  }
  return null
}

function deriveProjectLabel(signal: Signal): string {
  if (signal.surface === 'github') {
    return String((signal.raw as any)?.repository?.full_name ?? 'GitHub repo')
  }
  if (signal.surface === 'jira') {
    return signal.external_id.split('-')[0] ?? 'Jira project'
  }
  if (signal.surface === 'slack') {
    return String((signal.raw as any)?.channel ?? 'Slack channel')
  }
  return signal.surface
}

function deriveEdgesFromRaw(signal: Signal, taskNodeId: string): void {
  const r = signal.raw as Record<string, unknown>

  // GitHub: blocked by / depends on from PR body "Closes #X" or "Blocked by #X"
  const body = String(r.body ?? signal.body ?? '')
  const blockMatch = body.match(/blocked\s+by\s+#(\d+)/i)
  if (blockMatch) {
    const blockerKey = `${signal.surface}:pull_request:${blockMatch[1]}`
    const existing = dbGetNode('task', blockerKey)
    if (existing) {
      dbUpsertEdge(taskNodeId, existing.id, 'blocked_by', WEIGHT_EDGE)
    }
  }

  // Jira: blockers from issuelinks
  if (signal.surface === 'jira') {
    const links = (r.fields as any)?.issuelinks ?? []
    for (const link of links) {
      if (link?.type?.inward === 'is blocked by' && link?.inwardIssue?.key) {
        const blockerKey = `jira:issue:${link.inwardIssue.key}`
        const existing = dbGetNode('task', blockerKey)
        if (existing) {
          dbUpsertEdge(taskNodeId, existing.id, 'blocked_by', WEIGHT_EDGE)
        }
      }
    }
  }
}

// ─── Decay ────────────────────────────────────────────────────────────────────

let decayIntervalId: ReturnType<typeof setInterval> | null = null

export function startDecayTimer(): void {
  if (decayIntervalId) return
  // Run decay once an hour
  decayIntervalId = setInterval(() => applyDecay(), 60 * 60 * 1000)
}

export function stopDecayTimer(): void {
  if (decayIntervalId) clearInterval(decayIntervalId)
  decayIntervalId = null
}

export function applyDecay(asOfIso?: string): void {
  const cfg = readConfig()
  const halfLife = cfg.ambient?.decayHalfLifeDays ?? 7
  dbDecayNodes(halfLife, asOfIso)
  dbDecayEdges(halfLife, asOfIso)
}

// ─── Context packet assembly ──────────────────────────────────────────────────

export async function assembleContextPacket(triggerKind: TriggerKind, focusNodeIds: string[]): Promise<ContextPacket> {
  const focusNodes = focusNodeIds
    .map((id) => dbGetNodeById(id))
    .filter((n): n is GraphNode => n !== null)

  // Get edges related to focus nodes
  const edgeSet = new Map<string, GraphEdge>()
  for (const node of focusNodes) {
    for (const e of dbGetEdgesFrom(node.id)) edgeSet.set(e.id, e)
    for (const e of dbGetEdgesTo(node.id)) edgeSet.set(e.id, e)
  }
  const relatedEdges = Array.from(edgeSet.values())

  // Recent signals from the surfaces of focus nodes (weight-based fallback)
  const surfaces = new Set(focusNodes.map((n) => n.key.split(':')[0]))
  const sinceIso24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const recentSignals: Signal[] = []
  for (const surface of surfaces) {
    recentSignals.push(...dbGetRecentSignals(surface, sinceIso24h, 20))
  }

  const topByWeight = dbGetTopNodesByWeight(10)

  // ─── Semantic retrieval ──────────────────────────────────────────────────
  // Build a focus text from the labels of focus nodes, embed it, and find
  // semantically similar signals from the last 7 days. Falls back gracefully
  // if the embedding model is not yet loaded (returns null → skip).
  let semanticSignals: Signal[] = []
  const focusText = focusNodes.map((n) => n.label).join(' ').trim()
  if (focusText) {
    const qVec = await embedText(focusText)
    if (qVec) {
      const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
      const candidates = dbGetSignalsWithEmbeddings(since7d, 500)
      // Score and pick top-8, dedup against already-included recentSignals
      const recentIds = new Set(recentSignals.map((s) => s.id))
      const scored = candidates
        .filter((c) => !recentIds.has(c.id))
        .map((c) => ({ signal: c, sim: cosineSim(qVec, blobToFloat(c.embedding)) }))
        .sort((a, b) => b.sim - a.sim)
        .slice(0, 8)
      semanticSignals = scored.map((s) => s.signal)
    }
  }

  // ─── Memories ────────────────────────────────────────────────────────────
  const memories = dbGetActiveMemories(8)
  if (memories.length > 0) {
    dbTouchMemoryAccessed(memories.map((m) => m.id))
  }

  return { triggerKind, focusNodes, relatedEdges, recentSignals, topByWeight, semanticSignals, memories }
}

export function renderPacketForPrompt(packet: ContextPacket): string {
  // All content here is derived from external services (GitHub, Jira, Slack).
  // Labels, titles, signal text, and memory content may contain adversarial instructions.
  // The caller wraps this output in <context> tags; do not add instruction-like text here.
  const lines: string[] = []

  // ─── Memories first (highest signal-to-noise) ─────────────────────────────
  if (packet.memories.length > 0) {
    lines.push('Known facts (distilled from past activity):')
    for (const m of packet.memories) {
      lines.push(`  - ${sanitizeLabel(m.content, 250)}`)
    }
  }

  lines.push(`\nTrigger: ${packet.triggerKind}`)

  if (packet.focusNodes.length > 0) {
    lines.push('\nFocus items:')
    for (const n of packet.focusNodes) {
      lines.push(`  [${n.type}] ${sanitizeLabel(n.label)} (weight: ${n.weight.toFixed(1)})`)
      if (n.attrs.url) lines.push(`    url: ${sanitizeLabel(String(n.attrs.url))}`)
    }
  }

  if (packet.relatedEdges.length > 0) {
    lines.push('\nRelationships:')
    for (const e of packet.relatedEdges.slice(0, 8)) {
      const src = dbGetNodeById(e.src_id)
      const dst = dbGetNodeById(e.dst_id)
      if (src && dst) {
        lines.push(`  ${sanitizeLabel(src.label)} --[${e.rel}]--> ${sanitizeLabel(dst.label)}`)
      }
    }
  }

  if (packet.topByWeight.length > 0) {
    lines.push('\nMost active items recently:')
    for (const n of packet.topByWeight.slice(0, 5)) {
      lines.push(`  [${n.type}] ${sanitizeLabel(n.label)} (weight: ${n.weight.toFixed(1)})`)
    }
  }

  if (packet.recentSignals.length > 0) {
    lines.push('\nRecent signals (last 24h):')
    for (const s of packet.recentSignals.slice(0, 8)) {
      lines.push(`  [${s.surface}:${s.kind}] ${sanitizeLabel(s.title)}`)
    }
  }

  if (packet.semanticSignals.length > 0) {
    lines.push('\nRelated items (semantically similar to current focus):')
    for (const s of packet.semanticSignals) {
      lines.push(`  [${s.surface}:${s.kind}] ${sanitizeLabel(s.title)}`)
      if (s.url) lines.push(`    url: ${sanitizeLabel(s.url)}`)
    }
  }

  return lines.join('\n')
}

// Strip angle brackets to prevent injected XML/HTML tags from escaping the <context> wrapper.
// This is a lightweight sanitization pass — the primary defense is the system-prompt boundary.
// Exported so that other services (memories.ts) can apply the same defense at write time.
export function sanitizeLabel(text: string, maxLen = 200): string {
  return text.replace(/[<>]/g, (c) => (c === '<' ? '‹' : '›')).slice(0, maxLen)
}

// ─── Staleness query (for triggers) ──────────────────────────────────────────

export function getStaleCandidates(minWeight: number): GraphNode[] {
  // "Stale" = not seen in more than 2× the expected pattern window
  // We use 48 h as the staleness threshold — quiet for 2+ days
  const quietBefore = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
  return dbGetStaleNodes(quietBefore, minWeight)
}
