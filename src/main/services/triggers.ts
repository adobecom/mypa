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
    if (signals.length >= SPIKE_THRESHOLD) {
      const sinceIso = new Date(Date.now() - SPIKE_WINDOW_MS).toISOString()
      const [surface, kind] = key.split(':')
      const total = dbCountSignalsSince(surface, kind, sinceIso)
      if (total >= SPIKE_THRESHOLD) {
        hits.push({
          kind: 'spike',
          focusNodeIds: [],
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
    const existing = result.find((r) =>
      hit.focusNodeIds.length > 0 && r.focusNodeIds.some((id) => hit.focusNodeIds.includes(id))
    )
    if (existing) {
      existing.focusNodeIds = [...new Set([...existing.focusNodeIds, ...hit.focusNodeIds])]
      existing.reason += `; ${hit.reason}`
    } else {
      result.push({ ...hit, focusNodeIds: [...hit.focusNodeIds] })
    }
  }
  return result
}
