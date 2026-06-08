import type { Memory, GraphNode, GraphEdge } from '@shared/types'

/**
 * Build a self-contained Markdown export package suitable for direct
 * LLM ingestion to migrate the user's memory to a new system.
 *
 * Structure:
 *  1. Migration prompt  — instructions for the receiving LLM
 *  2. Memories          — grouped by type, human-readable
 *  3. Knowledge graph   — nodes by type, edges as `src --rel--> dst`
 *  4. JSON appendix     — lossless raw data for programmatic re-import
 */
export function buildMemoryExportMarkdown(
  memories: Memory[],
  nodes: GraphNode[],
  edges: GraphEdge[]
): string {
  const exportedAt = new Date().toISOString()
  const sections: string[] = []

  // ─── 1. Migration prompt ───────────────────────────────────────────────────
  sections.push(`# mypa Memory Export
*Exported: ${exportedAt}*

---

## Migration Prompt

You are receiving a full memory export from **mypa**, a local-first AI developer assistant.
The sections below contain everything the system learned about the user — their facts,
status updates, observed patterns, stated preferences, and the knowledge graph of entities
and relationships it tracked.

**Your task:** Ingest this data and reconstruct equivalent knowledge in the destination
system. Follow these steps:

1. **Read every memory entry** in the Memories section. For each one, decide whether to
   accept it as-is, merge it with related entries, or skip it if clearly outdated/superseded.
2. **Consult the Knowledge Graph** to understand which entities matter most (high-weight
   nodes), how they relate, and which edges encode trust-worthy relationships.
3. **Prioritise**: memories with \`status: active\` and high \`importance\` (> 0.7) should
   be ingested first. \`status: superseded\` memories are historical — use them for context
   but defer to the newer entry that superseded them.
4. **Surface types** indicate which tool/integration the memory came from
   (e.g. \`github\`, \`slack\`, \`jira\`, \`linear\`, \`notion\`). Use this to route re-ingestion.
5. **Graph weights** reflect recency and relevance: higher weight = more recently active.
   Nodes with weight < 0.05 may be safely ignored.
6. **Edges** encode relationships. Key relation types: \`depends_on\`, \`targets\`, \`authored\`,
   \`assigned_to\`, \`mentions\`, \`similar_to\`, \`supersedes\`, \`deferred\`.

The JSON appendix at the bottom is the authoritative data source for programmatic re-import.
The human-readable sections above it are for your understanding.

---
`)

  // ─── 2. Memories ──────────────────────────────────────────────────────────
  const types: Array<Memory['type']> = ['fact', 'status', 'pattern', 'preference']
  const byType = new Map<string, Memory[]>()
  for (const t of types) byType.set(t, [])
  for (const m of memories) {
    const bucket = byType.get(m.type) ?? []
    bucket.push(m)
    byType.set(m.type, bucket)
  }

  const typeLabels: Record<string, string> = {
    fact: 'Facts',
    status: 'Status updates',
    pattern: 'Observed patterns',
    preference: 'Preferences'
  }

  const memoryLines: string[] = ['## Memories\n']
  for (const t of types) {
    const bucket = byType.get(t) ?? []
    if (bucket.length === 0) continue
    memoryLines.push(`### ${typeLabels[t]} (${bucket.length})\n`)
    for (const m of bucket) {
      const flags: string[] = []
      if (m.status === 'superseded') flags.push('**[superseded]**')
      if (m.importance >= 0.8) flags.push('⭐ high-importance')
      const flagStr = flags.length > 0 ? ` ${flags.join(' ')}` : ''
      const surface = m.surface ? ` · surface: \`${m.surface}\`` : ''
      memoryLines.push(
        `- ${m.content}${flagStr}  \n` +
        `  *confidence: ${m.confidence.toFixed(2)} · importance: ${m.importance.toFixed(2)}${surface} · created: ${m.created_at.slice(0, 10)}*\n`
      )
    }
  }
  if (memories.length === 0) {
    memoryLines.push('*No memories recorded yet.*\n')
  }
  sections.push(memoryLines.join('\n'))

  // ─── 3. Knowledge graph ───────────────────────────────────────────────────
  const nodeById = new Map<string, GraphNode>()
  for (const n of nodes) nodeById.set(n.id, n)

  // Group nodes by type, sorted by weight desc
  const nodesByType = new Map<string, GraphNode[]>()
  for (const n of nodes) {
    const bucket = nodesByType.get(n.type) ?? []
    bucket.push(n)
    nodesByType.set(n.type, bucket)
  }

  const graphLines: string[] = ['## Knowledge Graph\n']
  graphLines.push(`**${nodes.length} nodes · ${edges.length} edges**\n`)

  if (nodes.length > 0) {
    graphLines.push('### Nodes\n')
    for (const [type, bucket] of nodesByType) {
      const sorted = bucket.slice().sort((a, b) => b.weight - a.weight)
      graphLines.push(`**${type}** (${bucket.length})\n`)
      for (const n of sorted) {
        const weightStr = n.weight > 0 ? ` · weight: ${n.weight.toFixed(2)}` : ''
        graphLines.push(`- \`${n.key}\` — ${n.label || '(unlabelled)'}${weightStr}`)
      }
      graphLines.push('')
    }
  } else {
    graphLines.push('*No graph nodes recorded yet.*\n')
  }

  if (edges.length > 0) {
    graphLines.push('### Edges\n')
    for (const e of edges) {
      const src = nodeById.get(e.src_id)
      const dst = nodeById.get(e.dst_id)
      const srcLabel = src ? `\`${src.key}\`` : `\`(unknown:${e.src_id.slice(0, 8)})\``
      const dstLabel = dst ? `\`${dst.key}\`` : `\`(unknown:${e.dst_id.slice(0, 8)})\``
      const w = e.weight > 0 ? ` (w: ${e.weight.toFixed(2)})` : ''
      graphLines.push(`- ${srcLabel} --${e.rel}--> ${dstLabel}${w}`)
    }
    graphLines.push('')
  }

  sections.push(graphLines.join('\n'))

  // ─── 4. JSON appendix ─────────────────────────────────────────────────────
  const appendix = {
    exported_at: exportedAt,
    memories,
    nodes,
    edges
  }
  sections.push(
    '## JSON Data Appendix\n\n' +
    '*Lossless raw export for programmatic re-import.*\n\n' +
    '```json\n' +
    JSON.stringify(appendix, null, 2) +
    '\n```\n'
  )

  return sections.join('\n---\n\n')
}
