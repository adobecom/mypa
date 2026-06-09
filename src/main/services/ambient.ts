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
  dbGetBadgeCount,
  dbAppendActionLog,
  dbGetAllPolicies,
  dbUpsertNode,
  dbBumpNodeWeight,
  dbUpsertEdge,
} from '../db/index'
import { readConfig } from './config'
import { callTool } from './mcp'
import { startIngestion, stopIngestion, pollOnce } from './ingestion'
import { ingestSignalIntoGraph, assembleContextPacket, startDecayTimer, stopDecayTimer } from './memory-graph'
import { evalEventTriggers, evalTime, coalesceHits } from './triggers'
import { inferIntent } from './inference'
import { enqueueEmbeddings, enqueueBackfill } from './embeddings'
import { runMemorySummarization } from './memories'
import {
  resolveTier,
  shouldAutoExecute,
  actionTypeOf,
  recordApproval,
  recordChallenge,
  recordDismissal,
  recordExecution,
  setTier as setTierPolicy,
  resetTrust as resetTrustPolicy
} from './autonomy'
import { setTrayState } from '../tray'
import { broadcast } from '../windows'
import type { Signal, Intent, IntentObject, TriggerKind, TrayState, DigestSlot, AmbientDigest, Tier } from '@shared/types'

// ─── Module state ─────────────────────────────────────────────────────────────

let getWidgetWin: (() => BrowserWindow | null) | null = null
const timeTriggerjobs = new Map<string, cron.ScheduledTask>()
let inferenceQueue: Promise<void> = Promise.resolve()
const MAX_INTENTS_PER_CYCLE = 3

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
  // Kick off one-time backfill of any signals that were inserted before
  // the embedding model was available (fire-and-forget, model may not be
  // downloaded yet — enqueueBackfill degrades gracefully)
  enqueueBackfill()
  console.log('[ambient] started')
}

export function stopAmbient(): void {
  stopIngestion()
  stopDecayTimer()
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
  let intentCount = 0

  // Seed covered set from intents already visible to the user so we skip hits
  // about the same nodes whether they arrive in this cycle or a later one.
  const covered = activeFocusNodeIds()

  for (const hit of hits) {
    if (intentCount >= MAX_INTENTS_PER_CYCLE) break

    // Skip hits whose focus nodes are already covered by a surfaced intent.
    // Focus-less hits (e.g. time digests) are never skipped — they have their
    // own purpose and won't collide with activity-based intents.
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

    const tier = resolveTier(obj)
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

    // Mark these focus nodes as covered so later hits in this same cycle are
    // also deduplicated without needing a DB round-trip.
    for (const id of hit.focusNodeIds) covered.add(id)

    dbAppendActionLog({
      intent_id: intent.id,
      event: 'emitted',
      action_type: actionTypeOf(obj),
      tier,
      detail: { trigger: hit.reason },
      created_at: new Date().toISOString()
    })

    await handleIntent(intent, win)
    intentCount++
  }
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

    win?.webContents.send('badge:updated', dbGetBadgeCount())
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
