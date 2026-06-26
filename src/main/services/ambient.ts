import { BrowserWindow, Notification } from 'electron'
import cron from 'node-cron'
import {
  dbCreateIntent,
  dbGetIntent,
  dbGetPendingIntents,
  dbGetResolvedIntentsSince,
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
  dbReproposeIntent,
  dbGetNodeById,
  dbGetSignalByExternal,
  dbGetDirectedSignals,
  dbAddIntentChatMessage,
  dbGetIntentChatThread,
  dbUpdateIntentChatMessageMetadata,
  dbGetPlanThread,
  dbUpdatePlanMessageMetadata,
} from '../db/index'
import { readConfig } from './config'
import { violatesScope } from './scope'
import { callTool, getToolInputSchema, ensureServersConnected } from './mcp'
import { startIngestion, stopIngestion, pollOnce, getLastCompletePollAt } from './ingestion'
import { ingestSignalIntoGraph, assembleContextPacket, startDecayTimer, stopDecayTimer, renderPacketForPrompt } from './memory-graph'
import { evalEventTriggers, evalTime, coalesceHits, evalWaitingOnMeFromGraph, evalStaleAndMine } from './triggers'
import { inferIntent, reproposeIntent } from './inference'
import { streamChat, cancelStream } from './claude'
import type { InferIntentResult } from './inference'
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
import type { Signal, Intent, IntentObject, TriggerKind, TrayState, DigestSlot, AmbientDigest, Tier, ChatMessage, IntentSurface, GraphNode, ProposedChatAction } from '@shared/types'

// ─── Module state ─────────────────────────────────────────────────────────────

let getWidgetWin: (() => BrowserWindow | null) | null = null
const timeTriggerjobs = new Map<string, cron.ScheduledTask>()
let inferenceQueue: Promise<void> = Promise.resolve()
const MAX_INTENTS_PER_CYCLE = 3

// Default cooldown windows (ms) during which a resolved intent suppresses the same
// work item from re-surfacing. A signal fingerprint change after resolution breaks
// through regardless of these windows.
const DEFAULT_RESOLUTION_COOLDOWN_MS: Record<string, number> = {
  dismissed:  7 * 24 * 60 * 60 * 1000,
  challenged: 7 * 24 * 60 * 60 * 1000,
  executed:   3 * 24 * 60 * 60 * 1000,
  failed:     1 * 24 * 60 * 60 * 1000,
  expired:    1 * 24 * 60 * 60 * 1000,
}
let synthesisIntervalId: ReturnType<typeof setInterval> | null = null
let synthesisInitialTimeoutId: ReturnType<typeof setTimeout> | null = null
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

  // Require at least one ingestion surface to be configured
  const ambientSurfaces = ['github', 'jira', 'slack', 'linear']
  const hasSurface = cfg.mcp_servers.some((s) => ambientSurfaces.includes(s.name))
  if (!hasSurface) {
    console.log('[ambient] no github/jira/slack/linear server configured, skipping start')
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
  if (hits.length === 0) {
    console.log(`[ambient] ${signals.length} new signal(s) — no trigger hits`)
    return
  }

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

// Returns the set of focus-node ids that are currently in cooldown from a recently
// resolved intent, suppressing re-surfacing of the same work item.
//
// Break-through rule: if the underlying signal's observed_at (a fingerprint-change
// timestamp) is newer than the intent's resolved_at, the item has genuinely new
// activity and is allowed through despite the cooldown.
function suppressedFocusNodeIds(): Set<string> {
  const ids = new Set<string>()
  const cfg = readConfig()
  const overrides = cfg.ambient?.resolutionCooldownMs ?? {}
  const cooldowns: Record<string, number> = { ...DEFAULT_RESOLUTION_COOLDOWN_MS, ...overrides }

  // Query only as far back as the longest cooldown window.
  const maxCooldown = Math.max(...Object.values(cooldowns))
  const cutoff = new Date(Date.now() - maxCooldown).toISOString()
  const resolved = dbGetResolvedIntentsSince(cutoff)

  for (const intent of resolved) {
    const status = intent.status as string
    const cooldownMs = cooldowns[status]
    if (cooldownMs === undefined) continue
    const resolvedAt = intent.resolved_at != null ? Date.parse(intent.resolved_at) : NaN
    if (isNaN(resolvedAt) || Date.now() - resolvedAt >= cooldownMs) continue // cooldown already elapsed

    const focusNodes = (intent.context_packet?.focusNodes ?? []) as Array<{
      id?: string
      key?: string
      type?: string
    }>
    for (const node of focusNodes) {
      if (!node.id) continue
      // Break-through check for work-item nodes only — non-work-item nodes (person,
      // repo, etc.) are always suppressed during cooldown.
      const key = node.key ?? ''
      const parts = key.split(':')
      if (parts.length >= 3 && WORK_ITEM_NODE_TYPES.has(node.type ?? parts[1])) {
        const surface = parts[0]
        const externalId = parts.slice(2).join(':')
        const signal = dbGetSignalByExternal(surface as IntentSurface, externalId)
        if (signal && intent.resolved_at != null && signal.observed_at > intent.resolved_at) {
          // The underlying work item has new activity since this intent was resolved —
          // allow a fresh intent through.
          continue
        }
      }
      ids.add(node.id)
    }
  }
  return ids
}

export async function runAmbientCycle(
  hits: ReturnType<typeof evalEventTriggers>
): Promise<void> {
  const win = getWidgetWin?.() ?? null

  // Phase A — infer ALL surviving hits (no early break), then rank
  // Build two guard sets:
  //   covered   — focus-node ids owned by a currently-pending/surfaced intent
  //   suppressed — focus-node ids in a post-resolution cooldown window
  const covered = activeFocusNodeIds()
  const suppressed = suppressedFocusNodeIds()
  const candidates: Array<{
    hit: ReturnType<typeof evalEventTriggers>[number]
    packet: Awaited<ReturnType<typeof assembleContextPacket>>
    obj: IntentObject
  }> = []

  let skippedCovered = 0
  let skippedCooldown = 0
  const dropCounts: Record<string, number> = {}

  for (const hit of hits) {
    // Skip hits whose focus nodes are already covered by a pending intent.
    if (hit.focusNodeIds.length > 0 && hit.focusNodeIds.some((id) => covered.has(id))) {
      console.log(`[ambient] skipping ${hit.kind} hit — focus nodes already covered`)
      skippedCovered++
      continue
    }
    // Skip hits whose focus nodes are within a post-resolution cooldown window.
    if (hit.focusNodeIds.length > 0 && hit.focusNodeIds.some((id) => suppressed.has(id))) {
      console.log(`[ambient] skipping ${hit.kind} hit — focus nodes in resolution cooldown`)
      skippedCooldown++
      continue
    }

    const packet = await assembleContextPacket(hit.kind, hit.focusNodeIds)
    let result: InferIntentResult
    try {
      result = await inferIntent(hit, packet)
    } catch (e) {
      console.error('[ambient] inference error:', e)
      dropCounts.error = (dropCounts.error ?? 0) + 1
      continue
    }
    if (!result.obj) {
      const reason = result.dropReason ?? 'unknown'
      dropCounts[reason] = (dropCounts[reason] ?? 0) + 1
      continue
    }

    // Mark focus nodes covered within this cycle to prevent same-cycle duplicates
    for (const id of hit.focusNodeIds) covered.add(id)
    candidates.push({ hit, packet, obj: result.obj })
  }

  console.log(`[ambient] cycle — ${hits.length} hit(s), ${skippedCovered} skipped (covered), ${skippedCooldown} skipped (cooldown), ${candidates.length} inferred${Object.keys(dropCounts).length > 0 ? `, dropped: ${JSON.stringify(dropCounts)}` : ''}`)

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

    // Inject surface-specific routing identifiers (owner/repo/issue_number for GitHub,
    // issue_key for Jira, channel_id/thread_ts for Slack) into the payload so that
    // buildToolArgs can assemble the correct MCP tool arguments at execution time.
    enrichPayloadForRouting(obj, packet.focusNodes as GraphNode[])

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
  // Lift the directed-signals query so we can log the count before passing it in,
  // avoiding a redundant DB query inside evalWaitingOnMeFromGraph.
  const directed = dbGetDirectedSignals()
  const waitingHits = evalWaitingOnMeFromGraph(directed)
  const staleHits = evalStaleAndMine()
  const hits = coalesceHits([...waitingHits, ...staleHits])
  console.log(`[ambient] synthesis heartbeat — ${directed.length} directed signal(s), ${waitingHits.length} waiting hit(s), ${staleHits.length} stale hit(s), ${hits.length} coalesced hit(s)`)

  // Write a diagnostic action-log row so the user can query the ambient pipeline
  // state via ambient:get-log without needing to grep console output.
  dbAppendActionLog({
    intent_id: null, // diagnostic row — not tied to a specific intent
    event: 'diag',
    action_type: 'heartbeat',
    tier: 1,
    detail: {
      directedSignals: directed.length,
      waitingHits: waitingHits.length,
      staleHits: staleHits.length,
      totalHits: hits.length,
    },
    created_at: new Date().toISOString()
  })

  if (hits.length === 0) return
  inferenceQueue = inferenceQueue
    .then(() => runAmbientCycle(hits))
    .catch((e) => console.error('[ambient] synthesis cycle error:', e))
}

function startSynthesisTimer(): void {
  if (synthesisIntervalId) return
  const cfg = readConfig()
  const intervalMs = cfg.ambient?.synthesisIntervalMs ?? 30 * 60 * 1000
  const initialDelayMs = cfg.ambient?.synthesisInitialDelayMs ?? 75_000

  // Fire an initial heartbeat tick after a short delay so items already waiting
  // on the user surface promptly after boot, instead of waiting the full interval
  // (default 30 min). The delay (~75 s) lands after the ingestion stagger completes
  // (github+3s, jira+23s, slack+43s) so the DB has up-to-date directed signals.
  synthesisInitialTimeoutId = setTimeout(() => {
    synthesisInitialTimeoutId = null
    runSynthesisHeartbeat()
  }, initialDelayMs)

  synthesisIntervalId = setInterval(runSynthesisHeartbeat, intervalMs)
}

function stopSynthesisTimer(): void {
  if (synthesisInitialTimeoutId) {
    clearTimeout(synthesisInitialTimeoutId)
    synthesisInitialTimeoutId = null
  }
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
      intentMissCount.delete(intent.id)
    }
  }
}

function startRevalidationTimer(): void {
  if (revalidationIntervalId) return
  const cfg = readConfig()
  const intervalMs = cfg.ambient?.pollIntervalMs ?? 5 * 60 * 1000
  // Serialize through inferenceQueue so timer ticks never race with ambientPollNow on intentMissCount.
  revalidationIntervalId = setInterval(() => {
    inferenceQueue = inferenceQueue
      .then(() => revalidatePendingIntents())
      .catch((e) => console.error('[ambient] revalidation error:', e))
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

// Shared surfacing path for all tiers: mark surfaced, push to renderer, notify + badge
// for actionable intents (flag/digest are informational — no interruption).
function surfaceIntent(intentId: string, win: BrowserWindow | null): void {
  dbUpdateIntentStatus(intentId, 'surfaced')
  const updated = dbGetIntent(intentId)!
  pushIntent(updated, win)

  // Only notify and badge for actionable intents — informational ones (flag/digest)
  // live in the main-window Activity page and should not interrupt the user.
  if (updated.type === 'action') {
    const notif = new Notification({
      title: `mypa: ${updated.surface ?? 'ambient'}`,
      body: (updated.rationale ?? '').slice(0, 120),
      silent: !(readConfig().preferences.notification_sound ?? true)
    })
    notif.on('click', () => win?.show())
    notif.show()

    updateBadgeCount()
  }

  refreshTray(win)
}

async function handleIntent(intent: Intent, win: BrowserWindow | null): Promise<void> {
  const tier = intent.tier as Tier

  if (tier === 3) {
    // Locked — never auto-execute; surface with full notification + badge so the
    // user is alerted even while the widget is hidden (tray-only mode).
    surfaceIntent(intent.id, win)
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
  surfaceIntent(intent.id, win)
}

/**
 * Record an execution failure — updates DB, action log, and pushes the intent
 * so both windows reflect the new failed state immediately.
 */
function recordIntentFailure(intent: Intent, msg: string, win: BrowserWindow | null): void {
  const actionType = `${intent.surface}:${intent.verb}`
  dbUpdateIntentStatus(intent.id, 'failed', msg)
  dbAppendActionLog({
    intent_id: intent.id,
    event: 'failed',
    action_type: actionType,
    tier: intent.tier,
    detail: { error: msg },
    created_at: new Date().toISOString()
  })
  const updated = dbGetIntent(intent.id)!
  pushIntent(updated, win)
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

      const toolArgs = buildToolArgs(intent)

      // Pre-flight guard: validate assembled args against the tool's required inputSchema
      // before making the MCP call. This converts missing-arg failures (e.g. owner/repo
      // not found in the graph) into a clear human explanation instead of a raw -32603.
      const schema = getToolInputSchema(intent.surface, tool)
      if (schema) {
        const required = (schema.required as string[] | undefined) ?? []
        const missing = required.filter((k) => toolArgs[k] === undefined || toolArgs[k] === null)
        if (missing.length > 0) {
          const humanMsg = `Could not resolve required details (${missing.join(', ')}) for this ${intent.surface} action. The work item may not have been ingested yet. Use "Chat about it" to discuss or correct this action.`
          console.warn(`[ambient] pre-flight validation failed for ${actionType}: missing ${missing.join(', ')}`)
          recordIntentFailure(intent, humanMsg, win)
          return
        }
      }

      const toolResult = await callTool(intent.surface, tool, toolArgs)
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
    recordIntentFailure(intent, String(e?.message ?? e), win)
    return
  }

  const updated = dbGetIntent(intent.id)!
  pushIntent(updated, win)
  refreshTray(win)

  // Notify main window of the auto-executed action so it can surface a toast
  if (updated.status === 'executed') {
    broadcast('ambient:action-executed', updated)
  }
}

// ─── Routing identifier injection ────────────────────────────────────────────
//
// Inject surface-specific routing identifiers into the proposed action payload
// so that buildToolArgs can assemble correct MCP tool arguments at execution time.
// Identifiers are prefixed with _ to distinguish them from LLM-authored content
// and to strip them cleanly in the relevant buildToolArgs branch.
//
// This replaces the earlier inline Slack-only enrichment blocks in runAmbientCycle
// and routeIntent, and extends the same pattern to GitHub and Jira.

function enrichPayloadForRouting(obj: IntentObject, focusNodes: GraphNode[]): void {
  const { surface, verb } = obj.proposed_action

  if (surface === 'slack' && (verb === 'reply' || verb === 'send')) {
    // Node key format: "slack:message:{channelId}:{ts}"
    const msgNode = focusNodes.find((n) => n.key.startsWith('slack:message:'))
    if (msgNode) {
      const parts = msgNode.key.split(':')
      if (parts.length === 4 && parts[2]) {
        obj.proposed_action.payload = {
          ...obj.proposed_action.payload,
          _channel_id: parts[2],
          ...(verb === 'reply' ? { _thread_ts: parts[3] } : {})
        }
      }
    }
    return
  }

  if (surface === 'github') {
    // Find the PR or issue work-item node in the focus set
    const itemNode = focusNodes.find(
      (n) => n.key.startsWith('github:pull_request:') || n.key.startsWith('github:issue:')
    )
    if (!itemNode) return

    // Primary: parse owner/repo/number from the stored URL
    // URL format: https://github.com/{owner}/{repo}/pull/{number}
    //          or https://github.com/{owner}/{repo}/issues/{number}
    const url = typeof itemNode.attrs?.url === 'string' ? itemNode.attrs.url : ''
    const urlMatch = url.match(/github\.com\/([^/]+)\/([^/]+)\/(pull|issues)\/(\d+)/)
    if (urlMatch) {
      obj.proposed_action.payload = {
        ...obj.proposed_action.payload,
        _owner: urlMatch[1],
        _repo: urlMatch[2],
        _issue_number: urlMatch[4]
      }
      return
    }

    // Fallback: parse issue number from the node key tail (e.g. "github:pull_request:pull_request:188")
    const keyParts = itemNode.key.split(':')
    const num = keyParts[keyParts.length - 1]
    if (num && /^\d+$/.test(num)) {
      obj.proposed_action.payload = {
        ...obj.proposed_action.payload,
        _issue_number: num
        // _owner / _repo remain absent; pre-flight guard will catch this cleanly
      }
    }
    return
  }

  if (surface === 'jira') {
    // Jira external_id is the issue key, e.g. "PROJ-123".
    // The graph node key is "jira:issue:{external_id}" — extract the issue key portion.
    const issueNode = focusNodes.find((n) => n.key.startsWith('jira:issue:'))
    if (!issueNode) return
    // key = "jira:issue:PROJ-123" → external_id = "PROJ-123"
    const issueKey = issueNode.key.replace(/^jira:issue:/, '')
    if (issueKey) {
      obj.proposed_action.payload = {
        ...obj.proposed_action.payload,
        _issue_key: issueKey
      }
    }
    return
  }

  if (surface === 'linear') {
    // Linear external_id is the issue identifier, e.g. "ENG-123".
    // The graph node key is "linear:issue:{external_id}".
    // Note: linear_add_comment accepts the identifier format in addition to the
    // internal UUID, so passing the identifier directly is safe here.
    const issueNode = focusNodes.find((n) => n.key.startsWith('linear:issue:'))
    if (!issueNode) return
    const issueId = issueNode.key.replace(/^linear:issue:/, '')
    if (issueId) {
      obj.proposed_action.payload = {
        ...obj.proposed_action.payload,
        _issue_id: issueId
      }
    }
  }
}

// Verb → MCP tool mapping. Only mapped (surface, verb) pairs may be executed.
// verbToTool returns null for unmapped pairs to prevent arbitrary tool invocation.
const VERB_TO_TOOL: Record<string, Record<string, string>> = {
  github: {
    comment: 'add_issue_comment',
    label:   'add_labels_to_issue',
    approve: 'create_pull_request_review',
  },
  jira:   { comment: 'jira_add_comment' },
  slack:  { reply: 'conversations_add_message', send: 'conversations_add_message' },
  linear: { comment: 'linear_add_comment' }
}

// Hard allowlist of (surface:verb) pairs that may ever be auto-executed (tier < 2).
// Destructive write verbs (close, assign, merge) are deliberately excluded and will
// always be surfaced for user confirmation regardless of the stored policy tier.
const AUTO_EXECUTABLE: ReadonlySet<string> = new Set([
  'github:comment',
  'github:label',
  'jira:comment',
  'slack:reply',
  'slack:send',
  'linear:comment'
])

function verbToTool(surface: string, verb: string): string | null {
  return VERB_TO_TOOL[surface]?.[verb] ?? null
}

/**
 * Build the actual MCP tool arguments from an intent's payload.
 *
 * The LLM-authored payload contains the draft content (body, labels, etc.) plus
 * _-prefixed routing identifiers injected at intent-creation time by
 * enrichPayloadForRouting. This function maps both into the correct tool arg
 * shape and strips the internal _ fields from the outgoing call.
 */
function buildToolArgs(intent: Intent): Record<string, unknown> {
  const p = (intent.payload ?? {}) as Record<string, unknown>

  if (intent.surface === 'slack') {
    const { message, _channel_id, _thread_ts, ...rest } = p
    // Strip any other _ fields before passing to the tool
    const clean = Object.fromEntries(Object.entries(rest).filter(([k]) => !k.startsWith('_')))
    return {
      ...clean,
      channel_id: _channel_id,
      text: message,
      ...(_thread_ts ? { thread_ts: _thread_ts } : {})
    }
  }

  if (intent.surface === 'github') {
    const {
      _owner, _repo, _issue_number,
      // Explicit fallback fields the model may provide (no underscore prefix)
      owner: payloadOwner, repo: payloadRepo,
      issue_number: payloadIssueNumber, pull_number: payloadPullNumber,
      body, labels,
      ...rest
    } = p
    const clean = Object.fromEntries(Object.entries(rest).filter(([k]) => !k.startsWith('_')))

    // Routing: _-prefixed injected values win; model-provided payload values are the fallback
    const owner = (_owner as string | undefined) ?? (payloadOwner as string | undefined)
    const repo  = (_repo  as string | undefined) ?? (payloadRepo  as string | undefined)
    const rawNum = _issue_number ?? payloadIssueNumber ?? payloadPullNumber
    const issueNum = rawNum !== undefined ? Number(rawNum) : undefined

    if (intent.verb === 'label') {
      // add_labels_to_issue requires owner, repo, issue_number, labels
      return { ...clean, owner, repo, issue_number: issueNum, labels: labels ?? [] }
    }
    if (intent.verb === 'approve') {
      // create_pull_request_review — PRs use pull_number (same value as issue_number for PRs)
      return { ...clean, owner, repo, pull_number: issueNum, event: 'APPROVE', ...(body ? { body } : {}) }
    }
    // add_issue_comment and other verbs: owner + repo + issue_number + body
    return { ...clean, owner, repo, issue_number: issueNum, body }
  }

  if (intent.surface === 'jira') {
    const { _issue_key, body, comment, ...rest } = p
    const clean = Object.fromEntries(Object.entries(rest).filter(([k]) => !k.startsWith('_')))
    // Send under both keys: mcp-atlassian tools use either "comment" or "body"
    // depending on the server version; satisfying both avoids false pre-flight failures.
    const text = body ?? comment
    return { ...clean, issue_key: _issue_key, comment: text, body: text }
  }

  if (intent.surface === 'linear') {
    const { _issue_id, body, ...rest } = p
    const clean = Object.fromEntries(Object.entries(rest).filter(([k]) => !k.startsWith('_')))
    // linear_add_comment requires: issueId (identifier or UUID) and body (markdown)
    return { ...clean, issueId: _issue_id, body }
  }

  // Any future surface: strip _ fields and pass the rest verbatim
  return Object.fromEntries(Object.entries(p).filter(([k]) => !k.startsWith('_')))
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

  // Inject surface-specific routing identifiers (same enrichment as runAmbientCycle).
  enrichPayloadForRouting(obj, focusNodesForScope as GraphNode[])

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

/**
 * Revise the intent's proposal based on the existing "Chat about it" thread.
 *
 * Calls `reproposeIntent` with the full chat history and a synthetic instruction
 * so the LLM produces an updated proposal. If the re-proposal passes the
 * confidence/urgency floors the intent is updated in-place via `dbReproposeIntent`.
 * Either way, the assistant's reply is appended to the chat thread and broadcast
 * so the renderer shows it without re-opening the stream.
 *
 * This replaces the old standalone Suggest flow, giving one unified conversational
 * surface in the Chat panel with an explicit opt-in "Update the proposal" button.
 */
export async function reviseIntentFromChat(
  id: string
): Promise<{ intent: Intent; applied: boolean; message: string } | null> {
  const intent = dbGetIntent(id)
  if (!intent) throw new Error(`Intent ${id} not found`)

  const thread = dbGetIntentChatThread(id)

  let message = 'I reconsidered the proposal.'
  let applied = false
  try {
    const syntheticInstruction = 'Based on our conversation above, produce your revised proposal.'
    const result = await reproposeIntent(intent, thread, syntheticInstruction)
    if (result) {
      message = result.message
      if (result.intent) {
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
        applied = true
      }
    }
  } catch (e) {
    console.error('[ambient] reviseIntentFromChat error:', e)
    message = 'Sorry, I ran into an error reconsidering this proposal. Try again or use Challenge/Dismiss.'
  }

  // Append the assistant reply to the chat thread so the conversation stays coherent
  dbAddIntentChatMessage(id, 'assistant', message)
  const win = getWidgetWin?.() ?? null
  broadcast('ambient:chat-message', { intentId: id, chunk: message, done: true })

  const updated = dbGetIntent(id)!
  pushIntent(updated, win)
  refreshTray(win)
  updateBadgeCount()
  broadcast('ambient:intent-updated', updated)

  return { intent: updated, applied, message }
}

// ─── Intent chat thread (streaming "Chat about it") ──────────────────────────

export function ambientGetIntentChatThread(id: string): ChatMessage[] {
  return dbGetIntentChatThread(id)
}

async function executeChatAction(
  surface: string,
  verb: string,
  payload: Record<string, unknown>
): Promise<string> {
  const tool = verbToTool(surface, verb)
  if (!tool) throw new Error(`Unsupported action: ${surface}:${verb}`)

  const pseudoIntent = { surface, verb, payload } as unknown as Intent
  const toolArgs = buildToolArgs(pseudoIntent)

  const schema = getToolInputSchema(surface, tool)
  if (schema) {
    const required = (schema.required as string[] | undefined) ?? []
    const missing = required.filter((k) => toolArgs[k] === undefined || toolArgs[k] === null)
    if (missing.length > 0) {
      throw new Error(`Missing required details (${missing.join(', ')}) for this ${surface} action. The routing context may be incomplete.`)
    }
  }

  return callTool(surface, tool, toolArgs)
}

// ─── Typed-approval helpers ───────────────────────────────────────────────────

/** Phrases treated as "yes, execute the pending action". */
const AFFIRMATIVE_RE = /^\s*(go ahead|approve it|approve|yes do it|yes|do it|send it|post it|ship it|confirm|go for it)\s*\.?\s*$/i

/** Phrases treated as "no, dismiss the pending action". */
const DISMISSAL_RE = /^\s*(no|cancel|don'?t|don't|do not|dismiss|nevermind|never mind|stop|abort|skip it)\s*\.?\s*$/i

/** Return true if the user message is an unambiguous short affirmative. */
export function isAffirmative(text: string): boolean { return AFFIRMATIVE_RE.test(text.trim()) }

/** Return true if the user message is an unambiguous short dismissal. */
export function isDismissal(text: string): boolean { return DISMISSAL_RE.test(text.trim()) }

/**
 * Return the most recent pending-action message in a thread, or null.
 * Only messages with action.status === 'pending' are eligible.
 */
export function findLatestPendingAction(thread: ChatMessage[]): ChatMessage | null {
  for (let i = thread.length - 1; i >= 0; i--) {
    const msg = thread[i]
    if (msg.action?.status === 'pending') return msg
  }
  return null
}

/**
 * Handle one message in a streaming "Chat about it" conversation for an intent.
 *
 * Persists the user turn, streams the assistant reply via streamChat with live
 * read-only MCP tools wired in, persists each response segment, and broadcasts
 * chunk events to the renderer. Write-tool requests are gated by canUseTool in
 * agent.ts, which broadcasts chat:tool-approval-request and awaits user approval
 * via the InlineToolApproval chip. Available on every intent, including
 * failed/terminal ones, so the user can always discuss what went wrong.
 */
export async function handleIntentChat(intentId: string, userMessage: string): Promise<void> {
  const intent = dbGetIntent(intentId)
  if (!intent) throw new Error(`Intent ${intentId} not found`)

  const userMsg = dbAddIntentChatMessage(intentId, 'user', userMessage)

  // Load the full thread (includes the just-added user message at the end)
  const fullThread = dbGetIntentChatThread(intentId)
  // History for streaming = everything except the last message (the user turn we just added)
  const rawHistory = fullThread.slice(0, -1)

  // ── Fix 2: typed approval / dismissal ────────────────────────────────────
  // Only activate if the LAST message in the thread is a pending action (i.e., it was
  // the immediately preceding message). This avoids silently approving an older stale
  // pending chip when the user is replying to a newer conversational message.
  const lastMsg = rawHistory.length > 0 ? rawHistory[rawHistory.length - 1] : null
  const pendingMsg = lastMsg?.action?.status === 'pending' ? lastMsg : null
  if (pendingMsg && isAffirmative(userMessage)) {
    try {
      const result = await approveChatAction(intentId, pendingMsg.id)
      const note = result.status === 'executed'
        ? `Done — ${result.surface}:${result.verb} executed. ${result.resultText ? result.resultText.slice(0, 300) : ''}`.trim()
        : `Action ${result.status}${result.resultText ? ': ' + result.resultText.slice(0, 300) : ''}.`
      dbAddIntentChatMessage(intentId, 'assistant', note)
    } catch (err: any) {
      dbAddIntentChatMessage(intentId, 'assistant', `Failed to execute action: ${err?.message ?? String(err)}`)
    }
    // Broadcast user message and done together — no streaming indicator needed for this path
    broadcast('ambient:chat-user-message', { intentId, message: userMsg })
    broadcast('ambient:chat-message', { intentId, chunk: '', done: true })
    return
  }
  if (pendingMsg && isDismissal(userMessage)) {
    dismissChatAction(intentId, pendingMsg.id)
    dbAddIntentChatMessage(intentId, 'assistant', 'Action dismissed — nothing was posted.')
    broadcast('ambient:chat-user-message', { intentId, message: userMsg })
    broadcast('ambient:chat-message', { intentId, chunk: '', done: true })
    return
  }

  // Normal streamed path: broadcast user message to start the streaming indicator
  broadcast('ambient:chat-user-message', { intentId, message: userMsg })

  // ── Fix 1: render action-bearing messages into history the model can read ──
  // Action-only messages have empty content — replace with a synthetic status line
  // so the model knows what was proposed and what its current state is.
  const history = rawHistory.map((m) => {
    const action = m.action
    if (!action) return m
    const statusDesc: Record<string, string> = {
      pending:   'queued — awaiting the user\'s Approve/Dismiss (NOT yet executed)',
      executed:  'executed successfully',
      failed:    'failed to execute',
      dismissed: 'dismissed by the user',
    }
    const desc = statusDesc[action.status] ?? action.status
    const resultNote = action.resultText ? ` (${action.resultText.slice(0, 150)})` : ''
    return {
      ...m,
      content: `[proposed ${action.surface}:${action.verb} on "${action.target}" — status: ${desc}${resultNote}]`
    }
  })

  // Build context string from the intent's proposal and context packet
  const cp = intent.context_packet as Record<string, unknown> | undefined
  const contextLines: string[] = []
  contextLines.push(`**Insight type:** ${intent.type}`)
  contextLines.push(`**Proposed action:** ${intent.surface}:${intent.verb} — ${intent.target}`)
  contextLines.push(`**Rationale:** ${intent.rationale}`)
  if (intent.status === 'failed' && intent.error) {
    contextLines.push(`**Execution failed:** ${intent.error}`)
  }
  if (cp && typeof cp === 'object') {
    const rendered = renderPacketForPrompt(cp as any)
    if (rendered) contextLines.push(`\n**Work context:**\n${rendered}`)
  }
  const rawContext = contextLines.join('\n')

  const segments: string[] = ['']
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
        broadcast('ambient:chat-message', { intentId, chunk, done: false })
      },
      (_full) => { /* no-op; we save per-segment below */ },
      rawContext,
      `intentchat:${intentId}`,
      'chat',
      true  // enableMcp — wire read-only tools and the write-action protocol
    )

    const toSave = segments.filter((s) => s.trim())
    for (const seg of toSave) {
      dbAddIntentChatMessage(intentId, 'assistant', seg)
    }

    broadcast('ambient:chat-message', { intentId, chunk: '', done: true })
  } catch (err: any) {
    broadcast('ambient:chat-message', {
      intentId,
      chunk: '',
      done: true,
      error: err?.message ?? 'Claude failed to respond'
    })
  }
}

/**
 * Approve and execute a pending write action proposed in a chat message.
 *
 * Looks up the action from the message's metadata, optionally applies an
 * edited payload (so the user can tweak the text before approving), ensures
 * the server is connected, executes the action via callTool in-process,
 * records trust accumulation, and updates the message's action status.
 */
export async function approveChatAction(
  intentId: string,
  messageId: string,
  editedPayload?: Record<string, unknown>
): Promise<ProposedChatAction> {
  const thread = dbGetIntentChatThread(intentId)
  const msg = thread.find((m) => m.id === messageId)
  if (!msg?.action) throw new Error(`Message ${messageId} not found or has no pending action`)

  const action = msg.action
  if (action.status !== 'pending') {
    return action  // idempotent — already resolved
  }

  // Merge user-edited payload (preserves routing identifiers from the original)
  const finalPayload = editedPayload && Object.keys(editedPayload).length > 0
    ? { ...action.payload, ...editedPayload }
    : action.payload

  let updated: ProposedChatAction
  try {
    await ensureServersConnected()
    const resultText = await executeChatAction(action.surface, action.verb, finalPayload)
    recordApproval(`${action.surface}:${action.verb}`)
    dbAppendActionLog({
      intent_id: intentId,
      event: 'executed',
      action_type: `${action.surface}:${action.verb}`,
      tier: action.tier,
      detail: { from_chat: true },
      created_at: new Date().toISOString()
    })
    updated = { ...action, payload: finalPayload, status: 'executed', resultText: resultText.slice(0, 500) }
  } catch (err: any) {
    dbAppendActionLog({
      intent_id: intentId,
      event: 'failed',
      action_type: `${action.surface}:${action.verb}`,
      tier: action.tier,
      detail: { from_chat: true, error: (err?.message ?? String(err)) },
      created_at: new Date().toISOString()
    })
    updated = { ...action, status: 'failed', resultText: (err?.message ?? String(err)).slice(0, 500) }
  }

  dbUpdateIntentChatMessageMetadata(messageId, updated as unknown as Record<string, unknown>)
  return updated
}

/**
 * Dismiss a pending write action proposed in a chat message (no tier change).
 */
export function dismissChatAction(
  intentId: string,
  messageId: string
): ProposedChatAction {
  const thread = dbGetIntentChatThread(intentId)
  const msg = thread.find((m) => m.id === messageId)
  if (!msg?.action) throw new Error(`Message ${messageId} not found or has no pending action`)

  if (msg.action.status !== 'pending') return msg.action  // idempotent

  const updated: ProposedChatAction = { ...msg.action, status: 'dismissed' }
  dbUpdateIntentChatMessageMetadata(messageId, updated as unknown as Record<string, unknown>)
  return updated
}

/**
 * Approve and execute a pending write action in a plan-item chat thread.
 * Mirrors approveChatAction but reads from plan_item_threads and does not
 * reference an intent (no action_log entry — plan items have no intent FK).
 */
export async function approvePlanAction(
  itemId: string,
  messageId: string,
  editedPayload?: Record<string, unknown>
): Promise<ProposedChatAction> {
  const thread = dbGetPlanThread(itemId)
  const msg = thread.find((m) => m.id === messageId)
  if (!msg?.action) throw new Error(`Plan message ${messageId} not found or has no pending action`)

  const action = msg.action
  if (action.status !== 'pending') return action  // idempotent

  const finalPayload = editedPayload && Object.keys(editedPayload).length > 0
    ? { ...action.payload, ...editedPayload }
    : action.payload

  let updated: ProposedChatAction
  try {
    await ensureServersConnected()
    const resultText = await executeChatAction(action.surface, action.verb, finalPayload)
    recordApproval(`${action.surface}:${action.verb}`)
    updated = { ...action, payload: finalPayload, status: 'executed', resultText: resultText.slice(0, 500) }
  } catch (err: any) {
    updated = { ...action, status: 'failed', resultText: (err?.message ?? String(err)).slice(0, 500) }
  }

  dbUpdatePlanMessageMetadata(messageId, updated as unknown as Record<string, unknown>)
  return updated
}

/**
 * Dismiss a pending write action in a plan-item chat thread (no execution).
 */
export function dismissPlanAction(
  itemId: string,
  messageId: string
): ProposedChatAction {
  const thread = dbGetPlanThread(itemId)
  const msg = thread.find((m) => m.id === messageId)
  if (!msg?.action) throw new Error(`Plan message ${messageId} not found or has no pending action`)

  if (msg.action.status !== 'pending') return msg.action  // idempotent

  const updated: ProposedChatAction = { ...msg.action, status: 'dismissed' }
  dbUpdatePlanMessageMetadata(messageId, updated as unknown as Record<string, unknown>)
  return updated
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
    .filter((i) => i.status === 'surfaced' && i.type === 'action' && i.tier >= 2)
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
  if (pending.some((i) => i.tier >= 2)) return 'needs-you'
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
