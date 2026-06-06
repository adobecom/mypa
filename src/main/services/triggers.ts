import {
  dbCountSignalsSince,
  dbGetDependencyEdges,
  dbGetTopNodesByWeight,
  dbGetNode
} from '../db/index'
import { getStaleCandidates } from './memory-graph'
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
            .map((s) => dbGetNode('task', `${s.surface}:${s.kind}:${s.external_id}`)?.id)
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
// Fires when high-weight nodes have gone quiet longer than expected.

const STALENESS_MIN_WEIGHT = 3.0

export function evalStaleness(): TriggerHit[] {
  const stale = getStaleCandidates(STALENESS_MIN_WEIGHT)
  if (stale.length === 0) return []
  return [
    {
      kind: 'staleness',
      focusNodeIds: stale.slice(0, 3).map((n) => n.id),
      reason: `${stale.length} active item(s) went quiet for 48+ hours: ${stale
        .slice(0, 2)
        .map((n) => n.label)
        .join(', ')}`
    }
  ]
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
    // Resolve this signal to its task node in the memory graph
    const taskKey = `${signal.surface}:${signal.kind}:${signal.external_id}`
    const taskNode = dbGetNode('task', taskKey)
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

// ─── Threshold trigger ────────────────────────────────────────────────────────
// Fires when top nodes cross a weight ceiling, suggesting significant activity.

const THRESHOLD_WEIGHT = 10.0
const MAX_THRESHOLD_HITS = 2

export function evalThreshold(): TriggerHit[] {
  const top = dbGetTopNodesByWeight(5)
  const over = top.filter((n) => n.weight >= THRESHOLD_WEIGHT)
  if (over.length === 0) return []
  return [
    {
      kind: 'threshold',
      focusNodeIds: over.slice(0, MAX_THRESHOLD_HITS).map((n) => n.id),
      reason: `High-activity items: ${over
        .slice(0, 2)
        .map((n) => `${n.label} (${n.weight.toFixed(0)})`)
        .join(', ')}`
    }
  ]
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

export function evalEventTriggers(newSignals: Signal[]): TriggerHit[] {
  const hits: TriggerHit[] = [
    ...evalSpike(newSignals),
    ...evalDependency(newSignals)
  ]
  // Only add staleness/threshold occasionally (not every poll cycle)
  // Use a rough "every 6th call" gate via a module counter
  evaluationCount++
  if (evaluationCount % 6 === 0) {
    hits.push(...evalStaleness())
    hits.push(...evalThreshold())
  }
  return hits
}

let evaluationCount = 0

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
