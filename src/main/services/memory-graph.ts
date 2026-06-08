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
import { readConfig, getOwnerHandles } from './config'
import { embedText, cosineSim, blobToFloat } from './embeddings'
import type { Signal, GraphNode, GraphEdge, TriggerKind, Memory, NodeType } from '@shared/types'

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

/**
 * Maps a signal kind to a specific NodeType.
 * Exported so trigger evaluators can resolve signals to their nodes.
 */
export function kindToNodeType(kind: string): NodeType {
  if (kind === 'pull_request') return 'pull_request'
  if (kind === 'issue') return 'issue'
  if (kind === 'message') return 'message'
  return 'issue'
}

export function ingestSignalIntoGraph(signal: Signal): void {
  const now = signal.observed_at
  const workItemType = kindToNodeType(signal.kind)

  // Upsert the work-item node (pull_request, issue, or message)
  const workItemKey = `${signal.surface}:${signal.kind}:${signal.external_id}`
  const workItemNode = dbUpsertNode(workItemType, workItemKey, signal.title.slice(0, 120), {
    url: signal.url,
    surface: signal.surface,
    kind: signal.kind
  })
  dbBumpNodeWeight(workItemNode.id, WEIGHT_SIGNAL)
  // Timeline: link this signal to the work-item node so we can reconstruct how it evolved
  dbLinkNodeSignal(workItemNode.id, signal.id, signal.surface, signal.title.slice(0, 120), signal.occurred_at, now)

  // Upsert the container node (repo / project / channel) and link with part_of
  const { containerKey, containerType, containerLabel } = deriveContainer(signal)
  if (containerKey && containerType) {
    const containerNode = dbUpsertNode(containerType, containerKey, containerLabel ?? containerKey)
    dbBumpNodeWeight(containerNode.id, WEIGHT_SIGNAL * 0.5)
    // Edge: work_item part_of container
    dbUpsertEdge(workItemNode.id, containerNode.id, 'part_of', WEIGHT_EDGE)
  }

  // Upsert a sprint node when Jira sprint data is present
  if (signal.surface === 'jira') {
    const sprint = (signal.raw as any)?.fields?.sprint ?? null
    if (sprint?.id != null) {
      const sprintKey = `jira:sprint:${sprint.id}`
      const sprintLabel = String(sprint.name ?? `Sprint ${sprint.id}`)
      const sprintNode = dbUpsertNode('sprint', sprintKey, sprintLabel)
      dbBumpNodeWeight(sprintNode.id, WEIGHT_SIGNAL * 0.2)
      dbUpsertEdge(workItemNode.id, sprintNode.id, 'part_of', WEIGHT_EDGE)
    }
  }

  // Upsert the actor (person) node and emit a role-aware participation edge
  if (signal.actor) {
    const personKey = `${signal.surface}:person:${signal.actor}`
    const personNode = dbUpsertNode('person', personKey, signal.actor, { surface: signal.surface })
    dbBumpNodeWeight(personNode.id, WEIGHT_SIGNAL * 0.3)
    const actorRole = deriveActorRole(signal)
    if (actorRole === 'reviews') {
      dbUpsertEdge(personNode.id, workItemNode.id, 'reviews', WEIGHT_EDGE)
    } else if (actorRole === 'participates_in') {
      dbUpsertEdge(personNode.id, workItemNode.id, 'participates_in', WEIGHT_EDGE)
    } else {
      // default: authored
      dbUpsertEdge(personNode.id, workItemNode.id, 'authored', WEIGHT_EDGE)
    }
  }

  // Derive assignee edges from raw payload
  deriveAssigneeEdges(signal, workItemNode.id)

  // Derive @mention edges from body text
  deriveMentionEdges(signal, workItemNode.id)

  // Derive dependency edges from raw signal fields
  deriveEdgesFromRaw(signal, workItemNode.id)
}

type ContainerResult = {
  containerKey: string | null
  containerType: NodeType | null
  containerLabel: string | null
}

function deriveContainer(signal: Signal): ContainerResult {
  if (signal.surface === 'github') {
    const repo = (signal.raw as any)?.repository?.full_name ?? (signal.raw as any)?.repo ?? null
    if (!repo) return { containerKey: null, containerType: null, containerLabel: null }
    return { containerKey: `github:repo:${repo}`, containerType: 'repo', containerLabel: String(repo) }
  }
  if (signal.surface === 'jira') {
    const key = signal.external_id.split('-')[0] // "PROJ-123" → "PROJ"
    if (!key) return { containerKey: null, containerType: null, containerLabel: null }
    const projectName = String((signal.raw as any)?.fields?.project?.name ?? key)
    return { containerKey: `jira:project:${key}`, containerType: 'project', containerLabel: projectName }
  }
  if (signal.surface === 'slack') {
    const channel = (signal.raw as any)?.channel ?? null
    if (!channel) return { containerKey: null, containerType: null, containerLabel: null }
    return { containerKey: `slack:channel:${channel}`, containerType: 'channel', containerLabel: String(channel) }
  }
  return { containerKey: null, containerType: null, containerLabel: null }
}

/**
 * Determine the relationship role the signal actor played.
 * - GitHub PR review events → reviews
 * - Slack messages → participates_in (message author in channel)
 * - Everything else → authored
 */
function deriveActorRole(signal: Signal): 'authored' | 'reviews' | 'participates_in' {
  if (signal.kind === 'review' || signal.kind === 'pull_request_review') return 'reviews'
  if (signal.surface === 'slack' && signal.kind === 'message') return 'participates_in'
  return 'authored'
}

/** Upsert assignee person nodes and emit assigned_to edges (work_item → person). */
function deriveAssigneeEdges(signal: Signal, workItemNodeId: string): void {
  const raw = signal.raw as Record<string, unknown>

  // GitHub: single assignee or array of assignees
  const ghAssignees: string[] = []
  const singleAssignee = (raw.assignee as any)?.login
  if (singleAssignee) ghAssignees.push(singleAssignee)
  const multiAssignees = Array.isArray(raw.assignees)
    ? (raw.assignees as any[]).map((a) => a?.login).filter(Boolean)
    : []
  for (const login of [...ghAssignees, ...multiAssignees]) {
    if (login === signal.actor) continue // already captured in actor edge
    const personKey = `${signal.surface}:person:${login}`
    const personNode = dbUpsertNode('person', personKey, String(login), { surface: signal.surface })
    dbUpsertEdge(workItemNodeId, personNode.id, 'assigned_to', WEIGHT_EDGE)
  }

  // Jira: fields.assignee
  if (signal.surface === 'jira') {
    const jiraAssignee = (raw.fields as any)?.assignee?.displayName
      ?? (raw.fields as any)?.assignee?.name
    if (jiraAssignee && jiraAssignee !== signal.actor) {
      const personKey = `jira:person:${jiraAssignee}`
      const personNode = dbUpsertNode('person', personKey, String(jiraAssignee), { surface: 'jira' })
      dbUpsertEdge(workItemNodeId, personNode.id, 'assigned_to', WEIGHT_EDGE)
    }
  }
}

/** Extract @mentions from body text and emit mentioned_in edges (person → work_item). */
function deriveMentionEdges(signal: Signal, workItemNodeId: string): void {
  const body = signal.body ?? ''
  if (!body) return
  const mentionRe = /@([\w.-]{2,39})/g
  let m: RegExpExecArray | null
  const seen = new Set<string>()
  while ((m = mentionRe.exec(body)) !== null) {
    const handle = m[1]
    if (handle === signal.actor) continue // actor already captured
    if (seen.has(handle)) continue
    seen.add(handle)
    const personKey = `${signal.surface}:person:${handle}`
    const personNode = dbUpsertNode('person', personKey, handle, { surface: signal.surface })
    dbBumpNodeWeight(personNode.id, WEIGHT_SIGNAL * 0.1)
    dbUpsertEdge(personNode.id, workItemNodeId, 'mentioned_in', WEIGHT_EDGE)
  }
}

function deriveEdgesFromRaw(signal: Signal, workItemNodeId: string): void {
  const r = signal.raw as Record<string, unknown>

  // GitHub: "blocked by #N" in PR body — the referenced item may be a PR or issue
  const body = String(r.body ?? signal.body ?? '')
  const blockMatch = body.match(/blocked\s+by\s+#(\d+)/i)
  if (blockMatch) {
    const n = blockMatch[1]
    const existing =
      dbGetNode('pull_request', `${signal.surface}:pull_request:${n}`) ??
      dbGetNode('issue', `${signal.surface}:issue:${n}`)
    if (existing) {
      dbUpsertEdge(workItemNodeId, existing.id, 'blocked_by', WEIGHT_EDGE)
    }
  }

  // GitHub: "Closes #N" / "Fixes #N" — the referenced item may be an issue or PR
  const closesMatch = body.match(/(?:closes|fixes|resolves)\s+#(\d+)/i)
  if (closesMatch) {
    const n = closesMatch[1]
    const existing =
      dbGetNode('issue', `${signal.surface}:issue:${n}`) ??
      dbGetNode('pull_request', `${signal.surface}:pull_request:${n}`)
    if (existing) {
      dbUpsertEdge(workItemNodeId, existing.id, 'references', WEIGHT_EDGE)
    }
  }

  // Jira: blockers from issuelinks
  if (signal.surface === 'jira') {
    const links = (r.fields as any)?.issuelinks ?? []
    for (const link of links) {
      if (link?.type?.inward === 'is blocked by' && link?.inwardIssue?.key) {
        const blockerKey = `jira:issue:${link.inwardIssue.key}`
        const existing = dbGetNode('issue', blockerKey)
        if (existing) {
          dbUpsertEdge(workItemNodeId, existing.id, 'blocked_by', WEIGHT_EDGE)
        }
      }
      if (link?.type?.outward === 'relates to' && link?.outwardIssue?.key) {
        const relKey = `jira:issue:${link.outwardIssue.key}`
        const existing = dbGetNode('issue', relKey)
        if (existing) {
          dbUpsertEdge(workItemNodeId, existing.id, 'relates_to', WEIGHT_EDGE)
        }
      }
    }
  }
}

// ─── Decay ────────────────────────────────────────────────────────────────────

let decayIntervalId: ReturnType<typeof setInterval> | null = null

export function startDecayTimer(): void {
  if (decayIntervalId) return
  // Run decay + semantic similarity once an hour
  decayIntervalId = setInterval(() => {
    applyDecay()
    buildSimilarityEdges().catch((e) => console.error('[memory-graph] similarity edges error:', e))
  }, 60 * 60 * 1000)
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

// ─── Semantic similarity edges ────────────────────────────────────────────────

const SIMILARITY_THRESHOLD = 0.82
const SIMILARITY_TOP_N = 12

/**
 * Embeds the labels of the top-weight nodes and creates `similar_to` edges
 * between pairs whose cosine similarity exceeds SIMILARITY_THRESHOLD.
 * Called hourly from the decay timer; no-ops gracefully if embeddings unavailable.
 */
export async function buildSimilarityEdges(): Promise<void> {
  const topNodes = dbGetTopNodesByWeight(SIMILARITY_TOP_N)
  if (topNodes.length < 2) return

  // Embed all node labels in parallel, drop any that fail
  const results = await Promise.all(topNodes.map(async (node) => {
    const vec = await embedText(node.label)
    return vec ? { node, vec } : null
  }))
  const embedded = results.filter((r): r is { node: typeof topNodes[0]; vec: Float32Array } => r !== null)

  for (let i = 0; i < embedded.length; i++) {
    for (let j = i + 1; j < embedded.length; j++) {
      const { node: a, vec: va } = embedded[i]
      const { node: b, vec: vb } = embedded[j]
      const sim = cosineSim(va, vb)
      if (sim >= SIMILARITY_THRESHOLD) {
        // Weight proportional to how far above threshold (max 1.0 at perfect similarity)
        dbUpsertEdge(a.id, b.id, 'similar_to', sim - SIMILARITY_THRESHOLD)
      }
    }
  }
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
  const ownerHandles = getOwnerHandles()

  /** If the raw label matches an owner handle (case-insensitive), return "you (<label>)". */
  function ownerLabel(raw: string): string {
    const trimmed = raw.trim()
    if (ownerHandles.length > 0 && ownerHandles.some((h) => h.toLowerCase() === trimmed.toLowerCase())) {
      return `you (${sanitizeLabel(trimmed)})`
    }
    return sanitizeLabel(trimmed)
  }

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
      lines.push(`  [${n.type}] ${ownerLabel(n.label)} (weight: ${n.weight.toFixed(1)})`)
      if (n.attrs.url) lines.push(`    url: ${sanitizeLabel(String(n.attrs.url))}`)
    }
  }

  if (packet.relatedEdges.length > 0) {
    lines.push('\nRelationships:')
    for (const e of packet.relatedEdges.slice(0, 8)) {
      const src = dbGetNodeById(e.src_id)
      const dst = dbGetNodeById(e.dst_id)
      if (src && dst) {
        lines.push(`  ${ownerLabel(src.label)} --[${e.rel}]--> ${ownerLabel(dst.label)}`)
      }
    }
  }

  if (packet.topByWeight.length > 0) {
    lines.push('\nMost active items recently:')
    for (const n of packet.topByWeight.slice(0, 5)) {
      lines.push(`  [${n.type}] ${ownerLabel(n.label)} (weight: ${n.weight.toFixed(1)})`)
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
