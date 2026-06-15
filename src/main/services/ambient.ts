import { BrowserWindow, Notification } from 'electron'
import cron from 'node-cron'
import {
  dbCreateIntent,
  dbGetIntent,
  dbGetPendingIntents,
  dbGetAllIntents,
  dbUpdateIntentStatus,
  dbSetIntentChallengeReason,
  dbUpdateIntentPayload,
  dbCreateAmbientActionRecord,
  dbAppendActionLog,
  dbGetAllPolicies,
  dbUpsertNode,
  dbBumpNodeWeight,
  dbUpsertEdge,
  dbAddIntentMessage,
  dbGetIntentThread,
  dbReproposeIntent,
  dbGetNodeById,
  dbGetSignalByExternal,
} from '../db/index'
import { readConfig } from './config'
import { violatesScope } from './scope'
import { callTool } from './mcp'
import { startIngestion, stopIngestion, pollOnce, getLastCompletePollAt } from './ingestion'
import { ingestSignalIntoGraph, assembleContextPacket, startDecayTimer, stopDecayTimer } from './memory-graph'
import { evalEventTriggers, evalTime, coalesceHits, evalWaitingOnMeFromGraph, evalStaleAndMine } from './triggers'
import { inferIntent, reproposeIntent } from './inference'
import { enqueueEmbeddings, enqueueBackfill, enqueueMemoryBackfill } from './embeddings'
import { runMemorySummarization } from './memories'
import {
  resolveTier,
  shouldAutoExecute,
  isMuted,
  actionTypeOf,
  recordApproval,
  recordChallenge,
  recordDismissal,
  recordExecution,
  setTier as setTierPolicy,
  resetTrust as resetTrustPolicy
} from './autonomy'
import { setTrayState } from '../tray'
import { broadcast, updateBadgeCount } from '../windows'
import type { Signal, Intent, IntentObject, TriggerKind, TrayState, DigestSlot, AmbientDigest, Tier, ChatMessage, IntentSurface } from '@shared/types'

// ─── Module state ─────────────────────────────────────────────────────────────

let getWidgetWin: (() => BrowserWindow | null) | null = null
const timeTriggerjobs = new Map<string, cron.ScheduledTask>()
let inferenceQueue: Promise<void> = Promise.resolve()
const MAX_INTENTS_PER_CYCLE = 3
let synthesisIntervalId: ReturnType<typeof setInterval> | null = null
let revalidationIntervalId: ReturnType<typeof setInterval> | null = null
// Tracks how many consecutive complete polls each intent's work-item signals were absent.
// Reset to 0 when the item reappears. Cleared when the intent is expired.
const intentMissCount = new Map<string, number>()

// ─── Start / stop ─────────────────────────────────────────────────────────────

export function startAmbient(getWin: () => BrowserWindow | null): void {
  const cfg = readConfig()
  if (!cfg.ambient?.enabled) {
    console.log('[ambient] disabled in config, skipping start')
    return
  }

  // Require at least one of github/jira/slack to be configured
  const ambientSurfaces = ['github', 'jira', 'slack']
  const hasSurface = cfg.mcp_servers.some((s) => ambientSurfaces.includes(s.name))
  if (!hasSurface) {
    console.log('[ambient] no github/jira/slack server configured, skipping start')
    return
  }

  getWidgetWin = getWin
  startDecayTimer()
  startIngestion(onNewSignals)
  scheduleTimeTriggers()
  startSynthesisTimer()
  startRevalidationTimer()
  // Kick off one-time backfill of any signals and memories that were inserted before
  // the embedding model was available (fire-and-forget, model may not be
  // downloaded yet — both functions degrade gracefully)
  enqueueBackfill()
  enqueueMemoryBackfill()
  console.log('[ambient] started')
}

export function stopAmbient(): void {
  stopIngestion()
  stopDecayTimer()
  stopSynthesisTimer()
  stopRevalidationTimer()
  for (const task of timeTriggerjobs.values()) task.stop()
  timeTriggerjobs.clear()
  getWidgetWin = null
  console.log('[ambient] stopped')
}

// ─── Ingestion callback ───────────────────────────────────────────────────────

function onNewSignals(signals: Signal[]): void {
  // Ingest each signal into the memory graph
  for (const signal of signals) {
    ingestSignalIntoGraph(signal)
  }

  // Enqueue background embedding for new signals (fire-and-forget, never blocks poll)
  enqueueEmbeddings(signals)

  // Evaluate event triggers
  const hits = coalesceHits(evalEventTriggers(signals))
  if (hits.length === 0) return

  // Run the inference cycle asynchronously, serialized
  inferenceQueue = inferenceQueue
    .then(() => runAmbientCycle(hits))
    .catch((e) => console.error('[ambient] cycle error:', e))
}

// ─── Ambient cycle ────────────────────────────────────────────────────────────

// Returns the set of focus-node ids already covered by any non-terminal intent,
// so runAmbientCycle can skip hits about subjects already surfaced to the user.
function activeFocusNodeIds(): Set<string> {
  const ids = new Set<string>()
  for (const intent of dbGetPendingIntents()) {
    const focusNodes = (intent.context_packet?.focusNodes ?? []) as Array<{ id: string }>
    for (const n of focusNodes) {
      if (n?.id) ids.add(n.id)
    }
  }
  return ids
}

export async function runAmbientCycle(
  hits: ReturnType<typeof evalEventTriggers>
): Promise<void> {
  const win = getWidgetWin?.() ?? null

  // Phase A — infer ALL surviving hits (no early break), then rank
  // Seed covered set from intents already visible to the user.
  const covered = activeFocusNodeIds()
  const candidates: Array<{
    hit: ReturnType<typeof evalEventTriggers>[number]
    packet: Awaited<ReturnType<typeof assembleContextPacket>>
    obj: IntentObject
  }> = []

  for (const hit of hits) {
    // Skip hits whose focus nodes are already covered by a pending intent.
    if (hit.focusNodeIds.length > 0 && hit.focusNodeIds.some((id) => covered.has(id))) {
      console.log(`[ambient] skipping ${hit.kind} hit — focus nodes already covered`)
      continue
    }

    const packet = await assembleContextPacket(hit.kind, hit.focusNodeIds)
    let obj: IntentObject | null
    try {
      obj = await inferIntent(hit, packet)
    } catch (e) {
      console.error('[ambient] inference error:', e)
      continue
    }
    if (!obj) continue

    // Mark focus nodes covered within this cycle to prevent same-cycle duplicates
    for (const id of hit.focusNodeIds) covered.add(id)
    candidates.push({ hit, packet, obj })
  }

  // Phase B — rank by (urgency desc, confidence desc), take top MAX_INTENTS_PER_CYCLE
  candidates.sort((a, b) =>
    b.obj.urgency - a.obj.urgency || b.obj.confidence - a.obj.confidence
  )
  const top = candidates.slice(0, MAX_INTENTS_PER_CYCLE)

  for (const { hit, packet, obj } of top) {
    const tier = resolveTier(obj)

    // Informational intents (flag/digest/suggestion) muted by the user's policy are
    // dropped here — they never reach the DB, the graph, or any UI surface.
    if (isMuted(obj.type, tier)) {
      console.log(`[ambient] ${obj.type} muted by policy — skipping`)
      continue
    }

    // Scope enforcement — drop intents whose containers are outside the configured
    // allowlists (e.g. allowedGithubOrgs). Conservative: if no container info is
    // available for a focus node, the intent is allowed through.
    if (violatesScope(obj, packet.focusNodes)) {
      console.log(`[ambient] intent dropped — out of scope (${obj.proposed_action.surface}: ${obj.proposed_action.target})`)
      continue
    }

    const intent = dbCreateIntent(obj, hit.kind as TriggerKind, tier, packet as unknown as Record<string, unknown>)

    // Mirror the intent into the knowledge graph so it appears alongside the
    // work items it concerns — enables cross-artifact reasoning in context packets.
    try {
      const intentLabel = (obj.rationale ?? `${obj.proposed_action.verb} intent`).slice(0, 120)
      const intentNode = dbUpsertNode('intent', `intent:${intent.id}`, intentLabel, {
        type: intent.type,
        surface: intent.surface,
        verb: intent.verb,
        tier,
        status: intent.status
      })
      dbBumpNodeWeight(intentNode.id, 1.5)
      // Link intent → focus nodes with targets edges
      for (const fn of packet.focusNodes.slice(0, 3)) {
        dbUpsertEdge(intentNode.id, fn.id, 'targets', 1.0)
      }
    } catch (e) {
      console.error('[ambient] intent graph node error:', e)
    }

    dbAppendActionLog({
      intent_id: intent.id,
      event: 'emitted',
      action_type: actionTypeOf(obj),
      tier,
      detail: { trigger: hit.reason, urgency: obj.urgency },
      created_at: new Date().toISOString()
    })

    await handleIntent(intent, win)
  }
}

// ─── Synthesis heartbeat ──────────────────────────────────────────────────────
// Fires periodically to re-evaluate "still waiting on me" and stale-and-mine items
// during quiet periods (no new signal arrivals). Decoupled from the poll callback.

function runSynthesisHeartbeat(): void {
  const waitingHits = evalWaitingOnMeFromGraph()
  const staleHits = evalStaleAndMine()
  const hits = coalesceHits([...waitingHits, ...staleHits])
  console.log(`[ambient] synthesis heartbeat — ${hits.length} hit(s)`)
  if (hits.length === 0) return
  inferenceQueue = inferenceQueue
    .then(() => runAmbientCycle(hits))
    .catch((e) => console.error('[ambient] synthesis cycle error:', e))
}

function startSynthesisTimer(): void {
  if (synthesisIntervalId) return
  const cfg = readConfig()
  const intervalMs = cfg.ambient?.synthesisIntervalMs ?? 30 * 60 * 1000
  // Defer first tick by one full interval (avoids colliding with startup stagger + backfill)
  synthesisIntervalId = setInterval(runSynthesisHeartbeat, intervalMs)
}

function stopSynthesisTimer(): void {
  if (synthesisIntervalId) clearInterval(synthesisIntervalId)
  synthesisIntervalId = null
}

// ─── Freshness revalidation ───────────────────────────────────────────────────
// Detects when a queued intent's underlying work item has disappeared from the
// user's active feed — closed PR, resolved issue, un-assigned ticket, etc.
//
// The mechanism is fully surface-agnostic: it uses the universal observation that
// any work item which was relevant to the user will stop appearing in adapter poll
// results once it's no longer active. No per-surface "is it closed?" logic needed.
//
// Safeguards against false positives:
//   1. Surface health gate — only expires when the surface adapter reports a complete poll.
//   2. Pagination guard  — adapters set complete=false if any query hit its page limit.
//   3. 2-poll debounce   — requires 2 consecutive misses before expiring.
//   4. All-items rule    — a multi-focus intent only expires when ALL work-item signals vanish.

// Node types that map to signals (work items). Non-work-item nodes (person, repo, etc.)
// are skipped — they don't disappear when a PR is closed.
const WORK_ITEM_NODE_TYPES = new Set(['pull_request', 'issue', 'message', 'document'])

function revalidatePendingIntents(): void {
  const win = getWidgetWin?.() ?? null
  const pending = dbGetPendingIntents()

  for (const intent of pending) {
    const focusNodes = (intent.context_packet?.focusNodes ?? []) as Array<{
      id?: string
      key?: string
      type?: string
    }>

    // Collect (surface, signal) pairs for work-item focus nodes only.
    // Node key format: "${surface}:${kind}:${external_id}" — kind === node type for work items.
    const workItems: Array<{ surface: IntentSurface; signal: ReturnType<typeof dbGetSignalByExternal> }> = []
    for (const node of focusNodes) {
      const key = node.key ?? node.id ?? ''
      if (!key) continue
      const parts = key.split(':')
      if (parts.length < 3) continue
      const surface = parts[0] as IntentSurface
      const nodeType = node.type ?? parts[1]
      if (!WORK_ITEM_NODE_TYPES.has(nodeType)) continue
      const externalId = parts.slice(2).join(':')
      const signal = dbGetSignalByExternal(surface, externalId)
      workItems.push({ surface, signal })
    }

    if (workItems.length === 0) {
      // No work-item signals linked — cannot assess freshness; leave intent as-is.
      intentMissCount.delete(intent.id)
      continue
    }

    // Determine whether ALL work-item signals have disappeared from their surface's latest
    // complete poll. Any signal still present resets the count for the whole intent.
    let allGone = true
    for (const { surface, signal } of workItems) {
      if (!signal) {
        // Signal row not found — skip this item (shouldn't happen for a valid intent)
        allGone = false
        break
      }
      const lastCompletePoll = getLastCompletePollAt(surface)
      if (!lastCompletePoll) {
        // No complete poll recorded yet for this surface — cannot confirm disappearance
        allGone = false
        break
      }
      if (lastCompletePoll <= intent.created_at) {
        // The last complete poll happened before this intent was even created — too soon to judge
        allGone = false
        break
      }
      if (signal.last_seen_at && signal.last_seen_at >= lastCompletePoll) {
        // Signal was seen at or after the last complete poll — item is still active
        allGone = false
        break
      }
    }

    if (allGone) {
      const count = (intentMissCount.get(intent.id) ?? 0) + 1
      intentMissCount.set(intent.id, count)
      console.log(`[ambient] intent ${intent.id} miss count: ${count}/2`)

      if (count >= 2) {
        // Two consecutive complete polls returned without this item — expire the intent.
        const surface = workItems[0].surface
        const reason = `No longer in your active ${surface} items (closed, merged, or reassigned)`
        dbUpdateIntentStatus(intent.id, 'expired', reason)
        dbAppendActionLog({
          intent_id: intent.id,
          event: 'expired',
          action_type: `${intent.surface ?? surface}:expired`,
          tier: intent.tier,
          detail: { reason },
          created_at: new Date().toISOString()
        })
        const updated = dbGetIntent(intent.id)
        if (updated) broadcast('ambient:intent-updated', updated)
        intentMissCount.delete(intent.id)
        refreshTray(win)
        console.log(`[ambient] intent ${intent.id} expired — ${reason}`)
      }
    } else {
      // Item is still present — reset miss counter
      if (intentMissCount.has(intent.id)) {
        intentMissCount.delete(intent.id)
      }
    }
  }
}

function startRevalidationTimer(): void {
  if (revalidationIntervalId) return
  const cfg = readConfig()
  const intervalMs = cfg.ambient?.pollIntervalMs ?? 5 * 60 * 1000
  revalidationIntervalId = setInterval(() => {
    try { revalidatePendingIntents() } catch (e) { console.error('[ambient] revalidation error:', e) }
  }, intervalMs)
}

function stopRevalidationTimer(): void {
  if (revalidationIntervalId) {
    clearInterval(revalidationIntervalId)
    revalidationIntervalId = null
  }
  intentMissCount.clear()
}

// ─── Intent routing by tier ───────────────────────────────────────────────────

async function handleIntent(intent: Intent, win: BrowserWindow | null): Promise<void> {
  const tier = intent.tier as Tier

  if (tier === 3) {
    // Locked — log and surface as flag only, never execute
    dbUpdateIntentStatus(intent.id, 'surfaced')
    pushIntent(dbGetIntent(intent.id)!, win)
    refreshTray(win)
    return
  }

  if (shouldAutoExecute(tier)) {
    // Tier 0: only auto-execute if the (surface, verb) pair is on the allowlist.
    // Verbs not in AUTO_EXECUTABLE (e.g. close, merge, assign) are always surfaced.
    const actionType = `${intent.surface}:${intent.verb}`
    if (AUTO_EXECUTABLE.has(actionType)) {
      await executeIntent(intent, win)
      return
    }
    // Not auto-executable — fall through to surface it
    console.log(`[ambient] ${actionType} not in AUTO_EXECUTABLE allowlist, surfacing at tier 1`)
  }

  // Tier 1, 2, or a tier-0 verb that isn't in the allowlist: surface for user attention
  dbUpdateIntentStatus(intent.id, 'surfaced')
  const updated = dbGetIntent(intent.id)!
  pushIntent(updated, win)

  // Only notify and badge for actionable intents — informational ones (flag/digest)
  // live in the main-window Activity page and should not interrupt the user.
  if (intent.type === 'action') {
    const notif = new Notification({
      title: `mypa: ${intent.surface ?? 'ambient'}`,
      body: (intent.rationale ?? '').slice(0, 120),
      silent: !(readConfig().preferences.notification_sound ?? true)
    })
    notif.on('click', () => win?.show())
    notif.show()

    updateBadgeCount()
  }

  refreshTray(win)
}

async function executeIntent(intent: Intent, win: BrowserWindow | null): Promise<void> {
  const actionType = `${intent.surface}:${intent.verb}`
  try {
    if (intent.surface && intent.verb && intent.verb !== 'none' && intent.verb !== 'summarize') {
      const tool = verbToTool(intent.surface, intent.verb)

      // Refuse to execute if the (surface, verb) pair is not in the known-tool map.
      // This closes the prompt-injection path where the LLM names an arbitrary MCP tool.
      if (!tool) {
        console.warn(`[ambient] refusing to execute unmapped verb "${actionType}" — surfacing instead`)
        dbUpdateIntentStatus(intent.id, 'surfaced')
        pushIntent(dbGetIntent(intent.id)!, win)
        refreshTray(win)
        return
      }

      const toolResult = await callTool(intent.surface, tool, intent.payload as Record<string, unknown>)
      console.log(`[ambient] auto-executed ${actionType}:`, toolResult.slice(0, 200))
    }

    dbUpdateIntentStatus(intent.id, 'executed')
    recordExecution(actionType)
    dbAppendActionLog({
      intent_id: intent.id,
      event: 'executed',
      action_type: actionType,
      tier: intent.tier,
      detail: {},
      created_at: new Date().toISOString()
    })

    // Graduate the executed intent into a done plan record so the Queue's Done
    // section shows a durable trail of what the agent did. Failures here are
    // non-fatal — they don't affect the intent's own executed status.
    try {
      dbCreateAmbientActionRecord(intent)
      updateBadgeCount()
    } catch (graduationErr) {
      console.error('[ambient] failed to create graduation plan record:', graduationErr)
    }
  } catch (e: any) {
    console.error(`[ambient] execution failed for ${actionType}:`, e)
    dbUpdateIntentStatus(intent.id, 'failed', String(e?.message ?? e))
    dbAppendActionLog({
      intent_id: intent.id,
      event: 'failed',
      action_type: actionType,
      tier: intent.tier,
      detail: { error: String(e) },
      created_at: new Date().toISOString()
    })
  }

  const updated = dbGetIntent(intent.id)!
  pushIntent(updated, win)
  refreshTray(win)

  // Notify main window of the auto-executed action so it can surface a toast
  if (updated.status === 'executed') {
    broadcast('ambient:action-executed', updated)
  }
}

// Verb → MCP tool mapping. Only mapped (surface, verb) pairs may be executed.
// verbToTool returns null for unmapped pairs to prevent arbitrary tool invocation.
const VERB_TO_TOOL: Record<string, Record<string, string>> = {
  github: { comment: 'create_issue_comment', label: 'add_labels_to_issue' },
  jira:   { comment: 'jira_add_comment' },
  slack:  { reply: 'slack_send_message', send: 'slack_send_message' }
}

// Hard allowlist of (surface:verb) pairs that may ever be auto-executed (tier < 2).
// Destructive write verbs (close, assign, merge) are deliberately excluded and will
// always be surfaced for user confirmation regardless of the stored policy tier.
const AUTO_EXECUTABLE: ReadonlySet<string> = new Set([
  'github:comment',
  'github:label',
  'jira:comment',
  'slack:reply',
  'slack:send'
])

function verbToTool(surface: string, verb: string): string | null {
  return VERB_TO_TOOL[surface]?.[verb] ?? null
}

// ─── External-pipeline routing ───────────────────────────────────────────────
// Called by other services (e.g. routines.ts) to route an already-inferred
// IntentObject through the same tier/DB/graph/notify pipeline as ambient intents.

export async function routeIntent(
  obj: IntentObject,
  triggerKind: TriggerKind,
  contextPacket: Record<string, unknown>,
  focusNodeIds: string[],
  win: BrowserWindow | null
): Promise<void> {
  const tier = resolveTier(obj)

  // Informational intents (flag/digest/suggestion) muted by the user's policy are
  // dropped here — they never reach the DB, the graph, or any UI surface.
  if (isMuted(obj.type, tier)) {
    console.log(`[ambient] ${obj.type} muted by policy — skipping`)
    return
  }

  // Scope enforcement — resolve focus node IDs to nodes for the scope check.
  const focusNodesForScope = focusNodeIds
    .map((id) => dbGetNodeById(id))
    .filter((n): n is NonNullable<typeof n> => n !== null)
  if (violatesScope(obj, focusNodesForScope)) {
    console.log(`[ambient] routeIntent dropped — out of scope (${obj.proposed_action.surface}: ${obj.proposed_action.target})`)
    return
  }

  const intent = dbCreateIntent(obj, triggerKind, tier, contextPacket)

  try {
    const label = (obj.rationale ?? `${obj.proposed_action.verb} intent`).slice(0, 120)
    const intentNode = dbUpsertNode('intent', `intent:${intent.id}`, label, {
      type: intent.type,
      surface: intent.surface,
      verb: intent.verb,
      tier,
      status: intent.status
    })
    dbBumpNodeWeight(intentNode.id, 1.5)
    for (const nodeId of focusNodeIds.slice(0, 3)) {
      dbUpsertEdge(intentNode.id, nodeId, 'targets', 1.0)
    }
  } catch (e) {
    console.error('[ambient] routeIntent graph node error:', e)
  }

  dbAppendActionLog({
    intent_id: intent.id,
    event: 'emitted',
    action_type: actionTypeOf(obj),
    tier,
    detail: { trigger: triggerKind },
    created_at: new Date().toISOString()
  })

  await handleIntent(intent, win)
}

// ─── IPC-callable operations ──────────────────────────────────────────────────

export function ambientGetIntents(): Intent[] {
  return dbGetPendingIntents()
}

export function ambientGetAllIntents(limit = 100): Intent[] {
  return dbGetAllIntents(limit)
}

export async function ambientApproveIntent(
  id: string,
  editedPayload?: Record<string, unknown>
): Promise<Intent> {
  const intent = dbGetIntent(id)
  if (!intent) throw new Error(`Intent ${id} not found`)
  const win = getWidgetWin?.() ?? null

  // Persist user-edited payload before execution so executeIntent reads the updated text
  if (editedPayload && Object.keys(editedPayload).length > 0) {
    dbUpdateIntentPayload(id, editedPayload)
  }

  dbUpdateIntentStatus(id, 'approved')
  recordApproval(`${intent.surface}:${intent.verb}`)
  dbAppendActionLog({
    intent_id: id,
    event: 'approved',
    action_type: `${intent.surface}:${intent.verb}`,
    tier: intent.tier,
    detail: { edited: !!editedPayload },
    created_at: new Date().toISOString()
  })

  // Execute the action (reads fresh intent from DB, which now has the edited payload)
  await executeIntent(dbGetIntent(id)!, win)
  return dbGetIntent(id)!
}

export function ambientDismissIntent(id: string): Intent | null {
  const intent = dbGetIntent(id)
  if (!intent) return null
  dbUpdateIntentStatus(id, 'dismissed')
  recordDismissal(`${intent.surface}:${intent.verb}`)
  dbAppendActionLog({
    intent_id: id,
    event: 'dismissed',
    action_type: `${intent.surface}:${intent.verb}`,
    tier: intent.tier,
    detail: {},
    created_at: new Date().toISOString()
  })
  const win = getWidgetWin?.() ?? null
  refreshTray(win)
  return dbGetIntent(id)
}

export async function ambientChallengeIntent(id: string, reason: string): Promise<Intent> {
  const intent = dbGetIntent(id)
  if (!intent) throw new Error(`Intent ${id} not found`)
  dbUpdateIntentStatus(id, 'challenged')
  dbSetIntentChallengeReason(id, reason)
  recordChallenge(`${intent.surface}:${intent.verb}`, reason)
  dbAppendActionLog({
    intent_id: id,
    event: 'challenged',
    action_type: `${intent.surface}:${intent.verb}`,
    tier: intent.tier,
    detail: { reason },
    created_at: new Date().toISOString()
  })
  const win = getWidgetWin?.() ?? null
  refreshTray(win)
  return dbGetIntent(id)!
}

export function ambientGetIntentThread(id: string): ChatMessage[] {
  return dbGetIntentThread(id)
}

/**
 * Handle one round of the multi-round Suggest loop.
 *
 * Persists the user message, calls `reproposeIntent` (which may make
 * read-only MCP tool calls), persists the assistant reply, updates the
 * intent's proposal fields in-place, then broadcasts updates.
 *
 * Returns the updated Intent plus the assistant message, or null on error.
 */
export async function ambientSuggestIntent(
  id: string,
  userMessage: string
): Promise<{ intent: Intent; assistantMessage: string } | null> {
  const intent = dbGetIntent(id)
  if (!intent) throw new Error(`Intent ${id} not found`)

  const thread = dbGetIntentThread(id)

  // Persist the user's message immediately
  dbAddIntentMessage(id, 'user', userMessage)

  let assistantMessage = 'I reconsidered the proposal.'
  try {
    const result = await reproposeIntent(intent, thread, userMessage)
    if (result) {
      assistantMessage = result.message
      // Update the intent's proposal in-place (status stays non-terminal)
      dbReproposeIntent(id, {
        verb: result.intent.proposed_action.verb,
        target: result.intent.proposed_action.target,
        payload: result.intent.proposed_action.payload,
        rationale: result.intent.rationale,
        confidence: result.intent.confidence,
        reversibility: result.intent.reversibility,
        required_approval: result.intent.required_approval
      })
    }
  } catch (e) {
    console.error('[ambient] reproposeIntent error:', e)
    assistantMessage = 'Sorry, I ran into an error reconsidering this. Try again or use Challenge/Dismiss.'
  }

  dbAddIntentMessage(id, 'assistant', assistantMessage)

  const updated = dbGetIntent(id)!
  const win = getWidgetWin?.() ?? null
  pushIntent(updated, win)
  refreshTray(win)
  updateBadgeCount()
  broadcast('ambient:intent-updated', updated)

  return { intent: updated, assistantMessage }
}

/**
 * Returns the lower-bound timestamp (ms) for each digest slot's time window.
 * - morning: since yesterday at 17:00 (overnight catch-up)
 * - midday:  since today at 00:00 (morning activity so far)
 * - eod:     since today at 00:00 (full-day recap)
 */
function slotWindow(slot: DigestSlot): number {
  const now = new Date()
  if (slot === 'morning') {
    // Yesterday at 17:00
    const yesterday = new Date(now)
    yesterday.setDate(yesterday.getDate() - 1)
    yesterday.setHours(17, 0, 0, 0)
    return yesterday.getTime()
  }
  // midday and eod: start of today
  const startOfDay = new Date(now)
  startOfDay.setHours(0, 0, 0, 0)
  return startOfDay.getTime()
}

export async function ambientGetDigest(slot?: DigestSlot): Promise<AmbientDigest> {
  const resolvedSlot: DigestSlot = slot ?? getCurrentSlot()
  const intents = dbGetAllIntents(50)
  const windowStartMs = slotWindow(resolvedSlot)
  const recent = intents.filter((i) => {
    if (!i.created_at) return false
    return Date.parse(i.created_at) >= windowStartMs
  })

  const did = recent
    .filter((i) => ['executed'].includes(i.status))
    .map((i) => `${i.rationale}`)
    .slice(0, 10)

  const watching = recent
    .filter((i) => i.status === 'surfaced')
    .map((i) => i.rationale)
    .slice(0, 10)

  const decisions = recent
    .filter((i) => i.status === 'pending' && i.required_approval)
    .map((i) => i.id)
    .slice(0, 5)

  return {
    slot: resolvedSlot,
    generated_at: new Date().toISOString(),
    section: { did, watching, decisions }
  }
}

export function ambientComputeTrayState(): TrayState {
  // Only actionable intents drive the tray state — informational (flag/digest) do not interrupt.
  const pending = dbGetPendingIntents().filter((i) => i.type === 'action')
  if (pending.some((i) => i.required_approval && i.tier >= 2)) return 'needs-you'
  if (pending.length > 0) return 'has-something'
  // Also consider recently auto-executed action intents in last hour
  const recent = dbGetAllIntents(20).filter((i) => {
    if (i.status !== 'executed' || i.type !== 'action') return false
    const age = Date.now() - Date.parse(i.created_at)
    return age < 60 * 60 * 1000
  })
  if (recent.length > 0) return 'has-something'
  return 'idle'
}

export function ambientGetPolicy() {
  return dbGetAllPolicies()
}

export function ambientSetAutonomyTier(actionType: string, tier: Tier, locked = false): void {
  setTierPolicy(actionType, tier, locked)
}

export function ambientResetTrust(): void {
  resetTrustPolicy()
}

export function ambientPollNow(): Promise<void> {
  // Route through inferenceQueue so a manual poll never runs concurrently with a
  // scheduled cycle (which could cause duplicate inference + concurrent auto-execution).
  inferenceQueue = inferenceQueue
    .then(async () => {
      const signals = await pollOnce()
      for (const signal of signals) ingestSignalIntoGraph(signal)
      const hits = coalesceHits(evalEventTriggers(signals))
      if (hits.length > 0) await runAmbientCycle(hits)
      // Revalidate after a manual poll so any disappeared items are retired immediately.
      revalidatePendingIntents()
    })
    .catch((e) => console.error('[ambient] pollNow error:', e))
  return inferenceQueue
}

// ─── Time triggers ────────────────────────────────────────────────────────────

const TIME_CRONS: Record<string, string> = {
  'ambient:morning': '0 8 * * 1-5',   // 8am weekdays
  'ambient:midday': '0 12 * * 1-5',   // noon weekdays
  'ambient:eod': '0 17 * * 1-5'       // 5pm weekdays
}

const SLOT_MAP: Record<string, DigestSlot> = {
  'ambient:morning': 'morning',
  'ambient:midday': 'midday',
  'ambient:eod': 'eod'
}

function scheduleTimeTriggers(): void {
  for (const [key, expr] of Object.entries(TIME_CRONS)) {
    if (!cron.validate(expr)) continue
    const slot = SLOT_MAP[key]
    const task = cron.schedule(expr, async () => {
      // Morning slot: run memory summarization first (through inferenceQueue so
      // it never competes with the claude CLI for active inference runs)
      if (key === 'ambient:morning') {
        inferenceQueue = inferenceQueue
          .then(() => runMemorySummarization())
          .catch((e) => console.error('[ambient] memory summarization error:', e))
      }
      const hits = evalTime(slot)
      inferenceQueue = inferenceQueue
        .then(() => runAmbientCycle(hits))
        .then(() => {
          const win = getWidgetWin?.() ?? null
          win?.webContents.send('ambient:digest-ready', slot)
        })
        .catch((e) => console.error('[ambient] time trigger error:', e))
    })
    timeTriggerjobs.set(key, task)
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pushIntent(intent: Intent, _win: BrowserWindow | null): void {
  // Broadcast to all windows so the main-window Activity page receives informational intents
  // and the widget receives actionable ones. Each window filters what it displays.
  broadcast('ambient:intent-created', intent)
}

function refreshTray(win: BrowserWindow | null): void {
  const state = ambientComputeTrayState()
  setTrayState(state)
  // Also notify the renderer so the tab dot updates
  win?.webContents.send('ambient:tray-state', state)
}

function getCurrentSlot(): DigestSlot {
  const h = new Date().getHours()
  if (h < 11) return 'morning'
  if (h < 15) return 'midday'
  return 'eod'
}
