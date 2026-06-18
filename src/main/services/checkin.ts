import { BrowserWindow } from 'electron'
import {
  dbCreateCheckIn,
  dbGetCheckIn,
  dbGetActiveCheckIn,
  dbUpdateCheckIn,
  dbAddCheckInMessage,
  dbGetCheckInThread,
  dbGetActiveMemories,
  dbGetAllIntents,
  dbCreateMemory,
  dbSupersedeMemory,
  dbGetNode,
  dbBumpNodeWeight,
  dbUpsertEdge
} from '../db/index'
import { streamChat, runClaude, cancelStream as cancelClaudeStream } from './claude'
import { assembleContextPacket, renderPacketForPrompt } from './memory-graph'
import { readConfig, updateConfig } from './config'
import { broadcast } from '../windows'
import { SCOPE_SURFACES, scopeSurfaceFor } from '@shared/scope-surfaces'
import type { CheckIn, CheckInExtractionSummary, MemoryInput, NodeType, EdgeRel } from '@shared/types'

// ─── Briefing generation ──────────────────────────────────────────────────────

async function streamBriefing(
  checkinId: string,
  win: BrowserWindow | null
): Promise<string> {
  const cfg = readConfig()
  const persona = cfg.persona?.trim() || 'a personal assistant'

  const packet = await assembleContextPacket('staleness', [])
  const context = renderPacketForPrompt(packet)

  const allIntents = dbGetAllIntents(10)
  const recentIntentLines = allIntents
    .slice(0, 8)
    .map((i) => `  - [${i.status}] ${i.rationale ?? `${i.verb ?? 'action'} on ${i.target ?? 'unknown'}`}`)
    .join('\n')

  // rawContext is injected into the system prompt by streamChat; compose it as the full context block
  const rawContext = `You are opening a 1:1 check-in session with your manager. Be transparent about what you have been doing, what you have learned, and where you need guidance. Aim for 200-350 words. Use plain text and bullet points.

Current knowledge state:
${context}

Recent intents you surfaced or acted on:
${recentIntentLines || '  (none in the last 7 days)'}`

  // Opening briefing prompt sent as the "user" turn (invisible system framing via rawContext)
  const briefingPrompt = `Write your opening briefing for this check-in covering:
1. What you have been tracking and what you have learned recently (2-4 key observations)
2. What you are uncertain about or where your knowledge feels incomplete
3. One or two questions you have for your manager

Speak in first person as ${persona}, directly to your manager.`

  const segments: string[] = ['']
  let fullResponse = ''

  await streamChat(
    [],
    briefingPrompt,
    (chunk) => {
      if (chunk === '\x00SPLIT\x00') {
        segments.push('')
      } else {
        segments[segments.length - 1] += chunk
      }
      broadcast('checkin:message', { checkinId, chunk, done: false })
    },
    (full) => { fullResponse = full },
    rawContext,
    checkinId,
    'checkin_chat',
    true  // enableMcp — live read-only tools in check-in briefings
  )

  broadcast('checkin:message', { checkinId, chunk: '', done: true })
  return fullResponse
}

// ─── Session management ───────────────────────────────────────────────────────

export async function startCheckIn(
  trigger: 'manual' | 'scheduled',
  win: BrowserWindow | null
): Promise<CheckIn> {
  const existing = dbGetActiveCheckIn()
  if (existing) return existing

  const checkin = dbCreateCheckIn(trigger)
  broadcast('checkin:started', checkin)

  streamBriefing(checkin.id, win)
    .then((briefingText) => {
      if (briefingText.trim()) {
        dbAddCheckInMessage(checkin.id, 'assistant', briefingText)
        dbUpdateCheckIn(checkin.id, { briefing: briefingText })
      }
    })
    .catch((err) => {
      console.error('[checkin] briefing stream failed:', err)
      broadcast('checkin:message', { checkinId: checkin.id, chunk: '', done: true, error: String(err) })
    })

  return checkin
}

export async function handleCheckInMessage(
  checkinId: string,
  userMessage: string,
  win: BrowserWindow | null
): Promise<void> {
  dbAddCheckInMessage(checkinId, 'user', userMessage)

  const history = dbGetCheckInThread(checkinId).slice(0, -1)

  const segments: string[] = ['']
  let fullResponse = ''
  try {
    await streamChat(
      history,
      userMessage,
      (chunk) => {
        if (chunk === '\x00SPLIT\x00') {
          segments.push('')
        } else {
          segments[segments.length - 1] += chunk
        }
        broadcast('checkin:message', { checkinId, chunk, done: false })
      },
      (full) => { fullResponse = full },
      undefined,
      checkinId,
      'checkin_chat',
      true  // enableMcp — live read-only tools in check-in conversation
    )
    const toSave = segments.filter((s) => s.trim())
    for (const seg of toSave.length > 0 ? toSave : [fullResponse]) {
      if (seg.trim()) dbAddCheckInMessage(checkinId, 'assistant', seg)
    }
    broadcast('checkin:message', { checkinId, chunk: '', done: true })
  } catch (err: any) {
    const error = err?.message ?? 'Claude failed to respond'
    broadcast('checkin:message', { checkinId, chunk: '', done: true, error })
  }
}

export async function endCheckIn(checkinId: string): Promise<void> {
  const now = new Date().toISOString()
  dbUpdateCheckIn(checkinId, { status: 'extracting', completed_at: now })
  broadcast('checkin:status-changed', dbGetCheckIn(checkinId))

  try {
    const summary = await extractAndApplyKnowledge(checkinId)
    dbUpdateCheckIn(checkinId, {
      status: 'complete',
      extraction_summary: JSON.stringify(summary)
    })
    broadcast('checkin:status-changed', dbGetCheckIn(checkinId))
  } catch (err) {
    console.error('[checkin] knowledge extraction failed:', err)
    dbUpdateCheckIn(checkinId, { status: 'error' })
    broadcast('checkin:status-changed', dbGetCheckIn(checkinId))
  }
}

export function cancelCheckinStream(checkinId: string): void {
  cancelClaudeStream(checkinId)
}

// ─── Knowledge extraction ─────────────────────────────────────────────────────

interface RawExtractionOutput {
  memories?: Array<{
    content: string
    type?: string
    enforcement?: string
    confidence?: number
    importance?: number
    supersedes_content?: string | null
  }>
  weight_adjustments?: Array<{
    node_type: string
    node_key: string
    delta: number
  }>
  new_edges?: Array<{
    src_type: string
    src_key: string
    dst_type: string
    dst_key: string
    rel: string
  }>
  /**
   * Absolute container-level focus restrictions extracted from the check-in.
   * Only populated when the manager states an explicit, unconditional constraint.
   */
  scope_rules?: Array<{
    surface?: string
    identifiers?: string[]
  }>
}

async function extractAndApplyKnowledge(checkinId: string): Promise<CheckInExtractionSummary> {
  const thread = dbGetCheckInThread(checkinId)
  if (thread.length === 0) return { memoriesAdded: 0, nodesUpdated: 0, edgesAdded: 0, scopeUpdated: 0 }

  const transcript = thread
    .map((m) => `[${m.role}]: ${m.content}`)
    .join('\n\n')

  const existingMemories = dbGetActiveMemories(30)
  const memoryList = existingMemories
    .map((m) => `  - "${m.content}"`)
    .join('\n')

  const systemPrompt = `You are a knowledge extraction agent for a personal assistant.
You receive the transcript of a check-in conversation between the assistant and its manager.
Extract structured knowledge updates that the assistant should remember going forward.
Respond ONLY with valid JSON matching the exact schema. No markdown, no explanation.`

  const userPrompt = `Transcript:
${transcript}

Existing memories (for superseding only — do not re-extract these unless the manager corrected them):
${memoryList || '  (none)'}

Extract knowledge updates as JSON:
{
  "memories": [
    {
      "content": "one concise sentence stating the fact, pattern, or preference",
      "type": "fact" | "pattern" | "preference" | "status",
      "enforcement": "hard" | "soft",
      "confidence": <0.0-1.0>,
      "importance": <0.0-1.0>,
      "supersedes_content": "<verbatim content of existing memory to replace, or null>"
    }
  ],
  "weight_adjustments": [
    { "node_type": "<NodeType>", "node_key": "<exact key>", "delta": <number> }
  ],
  "new_edges": [
    { "src_type": "<NodeType>", "src_key": "<key>", "dst_type": "<NodeType>", "dst_key": "<key>", "rel": "<EdgeRel>" }
  ],
  "scope_rules": [
    { "surface": "${SCOPE_SURFACES.map((s) => s.surface).join('" | "')}", "identifiers": ["<identifier>"] }
  ]
}

Rules:
- Only extract things the manager explicitly stated, confirmed, or corrected. Do not invent.
- If nothing actionable was said, return empty arrays for all fields.
- supersedes_content must be the verbatim content of an existing memory from the list above; use null for new facts.
- weight_adjustments: positive delta = more important, negative = less. Clamp between -3 and 3.
- new_edges: only use node keys visible in the transcript.
- Maximum: 10 memories, 5 weight_adjustments, 5 new_edges.
- enforcement: set "hard" ONLY for rules/boundaries the manager stated in absolute terms (e.g. "only surface X", "never do Y", "always include Z"). Set "soft" for preferences, guidance, and advisory instructions. Default to "soft" when in doubt — hard should be rare.
- scope_rules: ONLY when the manager states an absolute, unconditional restriction naming specific containers to focus on — e.g. "only surface work in the adobecom GitHub org", "just the WEB and PLAT Jira projects", "only the #eng-frontend Slack channel". surface must be one of: ${SCOPE_SURFACES.map((s) => `"${s.surface}" (${s.label.toLowerCase()})`).join(', ')}. identifiers are the org names / project keys / channel ids. Leave scope_rules empty when no such absolute restriction was stated — do NOT infer from casual org or project mentions.`

  const raw = await runClaude(systemPrompt, userPrompt, 'checkin_extract', 120_000, true)

  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return { memoriesAdded: 0, nodesUpdated: 0, edgesAdded: 0, scopeUpdated: 0 }

  let parsed: RawExtractionOutput
  try {
    parsed = JSON.parse(jsonMatch[0])
  } catch {
    return { memoriesAdded: 0, nodesUpdated: 0, edgesAdded: 0, scopeUpdated: 0 }
  }

  const summary: CheckInExtractionSummary = { memoriesAdded: 0, nodesUpdated: 0, edgesAdded: 0, scopeUpdated: 0 }
  const validMemoryTypes = new Set(['fact', 'pattern', 'preference', 'status'])

  for (const m of parsed.memories ?? []) {
    if (typeof m.content !== 'string' || !m.content.trim()) continue

    const input: MemoryInput = {
      content: m.content.trim(),
      type: validMemoryTypes.has(m.type ?? '') ? (m.type as any) : 'fact',
      enforcement: m.enforcement === 'hard' ? 'hard' : 'soft',
      confidence: clamp(m.confidence ?? 0.7, 0, 1),
      importance: clamp(m.importance ?? 0.6, 0, 1),
      surface: '',
      node_id: null
    }

    const newMemory = dbCreateMemory(input)
    summary.memoriesAdded++

    if (m.supersedes_content) {
      const match = existingMemories.find((em) => em.content === m.supersedes_content)
      if (match) dbSupersedeMemory(match.id, newMemory.id)
    }
  }

  for (const adj of parsed.weight_adjustments ?? []) {
    if (typeof adj.node_type !== 'string' || typeof adj.node_key !== 'string') continue
    const node = dbGetNode(adj.node_type as NodeType, adj.node_key)
    if (!node) continue
    dbBumpNodeWeight(node.id, clamp(adj.delta, -3, 3))
    summary.nodesUpdated++
  }

  for (const e of parsed.new_edges ?? []) {
    if (!e.src_type || !e.src_key || !e.dst_type || !e.dst_key || !e.rel) continue
    const src = dbGetNode(e.src_type as NodeType, e.src_key)
    const dst = dbGetNode(e.dst_type as NodeType, e.dst_key)
    if (!src || !dst) continue
    try {
      dbUpsertEdge(src.id, dst.id, e.rel as EdgeRel)
      summary.edgesAdded++
    } catch {
      // invalid rel or self-loop — skip
    }
  }

  // Derive scope allowlists from any absolute container restrictions the manager stated.
  // Union semantics: newly mentioned identifiers are added; nothing is removed.
  // deepMerge replaces arrays, so we compute the merged map here and write it all at once.
  if ((parsed.scope_rules ?? []).length > 0) {
    const currentAllowed: Record<string, string[]> = readConfig().scope?.allowed ?? {}
    const updatedAllowed: Record<string, string[]> = { ...currentAllowed }
    let totalAdded = 0

    for (const rule of parsed.scope_rules ?? []) {
      if (!rule.surface || !Array.isArray(rule.identifiers) || rule.identifiers.length === 0) continue
      const spec = scopeSurfaceFor(rule.surface)
      if (!spec) continue // unknown surface — skip

      const existing = (updatedAllowed[rule.surface] ?? []).map((s) => s.toLowerCase())
      const incoming: string[] = rule.identifiers
        .map((id: string) => {
          const trimmed = id.trim()
          // Uppercase Jira project keys to match the established convention.
          return rule.surface === 'jira' ? trimmed.toUpperCase() : trimmed
        })
        .filter(Boolean)

      const toAdd = incoming.filter((id) => !existing.includes(id.toLowerCase()))
      if (toAdd.length > 0) {
        updatedAllowed[rule.surface] = [...(updatedAllowed[rule.surface] ?? []), ...toAdd]
        totalAdded += toAdd.length
      }
    }

    if (totalAdded > 0) {
      updateConfig({ scope: { allowed: updatedAllowed } })
      summary.scopeUpdated = totalAdded
    }
  }

  return summary
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val))
}
