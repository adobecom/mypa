import {
  dbCountSignalsSince,
  dbGetDependencyEdges,
  dbGetTopNodesByWeight,
  dbGetNode,
  dbGetDirectedSignals
} from '../db/index'
import { getStaleCandidates, kindToNodeType } from './memory-graph'
import type { Signal, TriggerKind } from '@shared/types'

export interface TriggerHit {
  kind: TriggerKind
  focusNodeIds: string[]
  reason: string
}

// ─── Spike trigger ────────────────────────────────────────────────────────────
// Fires when a burst of signals arrives in a short window (3+ same surface/kind in 10 min).

const SPIKE_THRESHOLD = 3
const SPIKE_WINDOW_MS = 10 * 60 * 1000

export function evalSpike(newSignals: Signal[]): TriggerHit[] {
  const hits: TriggerHit[] = []
  const groups = new Map<string, Signal[]>()
  for (const s of newSignals) {
    const key = `${s.surface}:${s.kind}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(s)
  }
  for (const [key, signals] of groups) {
    const sinceIso = new Date(Date.now() - SPIKE_WINDOW_MS).toISOString()
    // Only count signals that actually occurred within the window — not signals
    // that were merely observed for the first time (e.g. the initial backfill
    // of all open PRs on first run, which all get observed_at=now).
    const recent = signals.filter((s) => !!s.occurred_at && s.occurred_at >= sinceIso)
    if (recent.length >= SPIKE_THRESHOLD) {
      const [surface, kind] = key.split(':')
      const total = dbCountSignalsSince(surface, kind, sinceIso)
      if (total >= SPIKE_THRESHOLD) {
        // Resolve the bursting signals to their memory-graph task nodes so that
        // coalesceHits can merge this spike hit with any threshold/dependency hit
        // that covers the same nodes, preventing the same burst from producing
        // two separate intents (one per hit) that land in different feed sections.
        const focusNodeIds = [...new Set(
          signals
            .map((s) => dbGetNode(kindToNodeType(s.kind), `${s.surface}:${s.kind}:${s.external_id}`)?.id)
            .filter((id): id is string => !!id)
        )].slice(0, 3)
        hits.push({
          kind: 'spike',
          focusNodeIds,
          reason: `Spike: ${total} ${key} signals in the last 10 minutes`
        })
      }
    }
  }
  return hits
}

// ─── Staleness trigger ────────────────────────────────────────────────────────
// Fires when high-weight nodes OWNED BY the user have gone quiet longer than expected.
// Only nodes the user is assigned to or review-requested on are considered — pure
// spectator nodes (involved only) are excluded to avoid nagging about others' work.

const STALENESS_MIN_WEIGHT = 3.0

export function evalStaleAndMine(): TriggerHit[] {
  const stale = getStaleCandidates(STALENESS_MIN_WEIGHT)
  if (stale.length === 0) return []

  // Restrict to nodes the user is responsible for by cross-referencing directed signals
  const directedSignals = dbGetDirectedSignals()
  const ownedNodeIds = new Set<string>()
  for (const sig of directedSignals) {
    if (sig.relation === 'assigned' || sig.relation === 'review_requested') {
      const key = `${sig.surface}:${sig.kind}:${sig.external_id}`
      const node = dbGetNode(kindToNodeType(sig.kind), key)
      if (node) ownedNodeIds.add(node.id)
    }
  }

  const mine = stale.filter((n) => ownedNodeIds.has(n.id))
  if (mine.length === 0) return []

  return [
    {
      kind: 'staleness',
      focusNodeIds: mine.slice(0, 3).map((n) => n.id),
      reason: `${mine.length} item(s) you own went quiet for 48+ hours: ${mine
        .slice(0, 2)
        .map((n) => n.label)
        .join(', ')}`
    }
  ]
}

// ─── Waiting-on-me trigger ────────────────────────────────────────────────────
// Fires when signals are structurally directed at the owner:
//   - review_requested: always directed
//   - assigned: owner is the assignee
//   - mentioned / dm / thread_reply: latest actor is a non-owner
// REQUEST_PATTERNS is kept as a secondary booster for the `mentioned` relation when
// the directed flag may be ambiguous (no latest actor available).

const REQUEST_PATTERNS = [
  /\?/,
  /\bcan (you|we|i)\b/i,
  /\bshould (you|we|i)\b/i,
  /\bplease\b/i,
  /\blgtm\b/i,
  /\breview\b/i,
  /\bapprove\b/i,
  /\bdefer\b/i,
  /\bmove to\b/i,
  /\bnext (sprint|release|milestone)\b/i,
  /\bwhat do you think\b/i,
  /\bis it (ok|okay)\b/i,
]

function buildWaitingHit(signal: Signal): TriggerHit | null {
  const nodeKey = `${signal.surface}:${signal.kind}:${signal.external_id}`
  const node = dbGetNode(kindToNodeType(signal.kind), nodeKey)

  const who = signal.last_actor || signal.actor || 'someone'
  let reason: string
  if (signal.relation === 'review_requested') {
    reason = `${who} requested your review on: ${signal.title.slice(0, 80)}`
  } else if (signal.relation === 'assigned') {
    reason = `Item assigned to you has activity from ${who}: ${signal.title.slice(0, 80)}`
  } else {
    reason = `${who} needs your attention on: ${signal.title.slice(0, 80)}`
  }

  return {
    kind: 'waiting',
    focusNodeIds: node ? [node.id] : [],
    reason
  }
}

/**
 * Fires for newly-polled signals that are structurally directed at the owner.
 * Used in the hot path (onNewSignals) alongside evalDependency and evalSpike.
 */
export function evalWaitingOnMe(newSignals: Signal[]): TriggerHit[] {
  const hits: TriggerHit[] = []
  for (const sig of newSignals) {
    const structural = sig.directed && sig.relation !== null &&
      ['review_requested', 'assigned', 'dm', 'thread_reply'].includes(sig.relation)

    // For `mentioned` with no `directed` flag, fall back to REQUEST_PATTERNS as a booster
    const boosted = !sig.directed && sig.relation === 'mentioned' &&
      REQUEST_PATTERNS.some((p) => p.test(`${sig.title} ${sig.body}`))

    if (!structural && !boosted) continue

    const hit = buildWaitingHit(sig)
    if (hit) hits.push(hit)
    if (hits.length >= 3) break // cap per cycle; coalesceHits merges same-node duplicates
  }
  return hits
}

/**
 * Heartbeat variant — queries persisted directed signals to re-surface items
 * that are still waiting on the owner even during quiet periods (no new arrivals).
 *
 * Accepts an optional pre-fetched `directed` array to avoid a redundant DB query
 * when the caller (runSynthesisHeartbeat) already has the result.
 */
export function evalWaitingOnMeFromGraph(directed?: ReturnType<typeof dbGetDirectedSignals>): TriggerHit[] {
  const signals = directed ?? dbGetDirectedSignals()
  const hits: TriggerHit[] = []
  for (const sig of signals) {
    const hit = buildWaitingHit(sig)
    if (hit) hits.push(hit)
    if (hits.length >= 5) break
  }
  return hits
}

// ─── Dependency trigger ───────────────────────────────────────────────────────
// Fires when a new signal touches a node that participates in a dependency edge.

export function evalDependency(newSignals: Signal[]): TriggerHit[] {
  if (newSignals.length === 0) return []
  const depEdges = dbGetDependencyEdges()
  if (depEdges.length === 0) return []

  // Build a set of node ids that appear in dependency edges
  const depNodeIds = new Set<string>()
  for (const e of depEdges) {
    depNodeIds.add(e.src_id)
    depNodeIds.add(e.dst_id)
  }

  const hits: TriggerHit[] = []
  for (const signal of newSignals) {
    // Resolve this signal to its work-item node in the memory graph
    const taskKey = `${signal.surface}:${signal.kind}:${signal.external_id}`
    const taskNode = dbGetNode(kindToNodeType(signal.kind), taskKey)
    if (!taskNode) continue

    // Only fire if the signal's own node participates in a dependency edge
    if (!depNodeIds.has(taskNode.id)) continue

    const matchingEdges = depEdges.filter(
      (e) => e.src_id === taskNode.id || e.dst_id === taskNode.id
    )
    const focusNodeIds = [...new Set(matchingEdges.flatMap((e) => [e.src_id, e.dst_id]))]
    hits.push({
      kind: 'dependency',
      focusNodeIds: focusNodeIds.slice(0, 3),
      reason: `Signal on a tracked dependency: ${signal.title.slice(0, 80)}`
    })
    break // one hit per cycle is enough
  }
  return hits
}

// ─── Time trigger ─────────────────────────────────────────────────────────────
// Fires for scheduled synthesis (morning / midday / eod).

export function evalTime(slot: 'morning' | 'midday' | 'eod'): TriggerHit[] {
  const top = dbGetTopNodesByWeight(5)
  return [
    {
      kind: 'time',
      focusNodeIds: top.slice(0, 3).map((n) => n.id),
      reason: `Scheduled ${slot} digest`
    }
  ]
}

// ─── Convenience: all event triggers ─────────────────────────────────────────
// Event-driven path: fires when new signals arrive. evalWaitingOnMe is the primary
// consequence-based trigger; evalDependency covers blocked/related items; evalSpike
// handles activity bursts. Staleness is driven by the synthesis heartbeat (ambient.ts)
// via evalStaleAndMine + evalWaitingOnMeFromGraph.

export function evalEventTriggers(newSignals: Signal[]): TriggerHit[] {
  return [
    ...evalWaitingOnMe(newSignals),
    ...evalDependency(newSignals),
    ...evalSpike(newSignals),
  ]
}

// ─── Coalesce hits sharing focus nodes ───────────────────────────────────────
// If two hits overlap in focusNodeIds, merge them into one to avoid
// emitting redundant intents.

export function coalesceHits(hits: TriggerHit[]): TriggerHit[] {
  if (hits.length <= 1) return hits
  const result: TriggerHit[] = []
  for (const hit of hits) {
    if (hit.focusNodeIds.length > 0) {
      // Merge into any existing hit that shares at least one focus node
      const existing = result.find((r) => r.focusNodeIds.some((id) => hit.focusNodeIds.includes(id)))
      if (existing) {
        existing.focusNodeIds = [...new Set([...existing.focusNodeIds, ...hit.focusNodeIds])]
        existing.reason += `; ${hit.reason}`
        continue
      }
    } else {
      // Focus-less hit (e.g. time/digest with an empty graph): merge with the
      // first existing result hit of the same kind to avoid duplicate inferences.
      const existing = result.find((r) => r.kind === hit.kind)
      if (existing) {
        existing.reason += `; ${hit.reason}`
        continue
      }
    }
    result.push({ ...hit, focusNodeIds: [...hit.focusNodeIds] })
  }
  return result
}
