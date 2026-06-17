/**
 * entity-link.ts — deterministic linkage between routine run output and known work items.
 *
 * After a routine collects its MCP output, `extractCoveredEntities` scans the text for
 * mentions of known signals and returns a snapshot of the matched work items. These are
 * persisted as `covered_entities` on the `routine_runs` row.
 *
 * The snapshot key (`surface:kind:external_id`) is constructed identically to the graph
 * node key in `memory-graph.ts`, so it matches insight `context_packet.focusNodes[].key`
 * exactly — enabling renderer-side linkage with no extra IPC calls.
 *
 * Matching strategy (in priority order):
 *  1. URL substring match — signal.url appears verbatim in rawOutput (high precision).
 *  2. external_id word-boundary match — for signals with empty url; guarded by surface
 *     prefix to reduce false positives on short numeric IDs (e.g. "482").
 *
 * Only WORK_ITEM_KINDS are considered — container nodes (repos, channels) are excluded
 * because they appear in almost every routine output and carry no per-item signal.
 */

import { dbGetRecentSignalsAllSurfaces } from '../db/index'
import type { CoveredEntity } from '@shared/types'

// Only match these signal kinds — they map to per-item work items the user acts on.
const WORK_ITEM_KINDS = new Set(['pull_request', 'issue', 'message', 'document'])

// Look back this many days for candidate signals to match against.
const LOOKBACK_DAYS = 14

/**
 * Scan `rawOutput` for references to known signals and return a deduplicated list
 * of matched work items as `CoveredEntity` snapshots.
 *
 * This is a pure read operation — no DB writes.
 */
export function extractCoveredEntities(rawOutput: string): CoveredEntity[] {
  if (!rawOutput) return []

  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const signals = dbGetRecentSignalsAllSurfaces(cutoff, 200)

  const seen = new Set<string>()
  const results: CoveredEntity[] = []

  for (const signal of signals) {
    if (!WORK_ITEM_KINDS.has(signal.kind)) continue

    const key = `${signal.surface}:${signal.kind}:${signal.external_id}`
    if (seen.has(key)) continue

    // Primary match: URL substring (most precise, no false positives)
    if (signal.url && rawOutput.includes(signal.url)) {
      seen.add(key)
      results.push({
        key,
        surface: signal.surface,
        kind: signal.kind,
        external_id: signal.external_id,
        title: signal.title,
        url: signal.url
      })
      continue
    }

    // Fallback: word-boundary match on external_id, guarded by surface name to reduce
    // false positives when external_id is a short number (e.g. "482").
    // We require the surface name or a "#" prefix to appear nearby in the output.
    if (!signal.url && signal.external_id) {
      const idPattern = new RegExp(`(?:^|\\W)${escapeRegex(signal.external_id)}(?:\\W|$)`)
      if (
        idPattern.test(rawOutput) &&
        rawOutput.toLowerCase().includes(signal.surface.toLowerCase())
      ) {
        seen.add(key)
        results.push({
          key,
          surface: signal.surface,
          kind: signal.kind,
          external_id: signal.external_id,
          title: signal.title,
          url: signal.url
        })
      }
    }
  }

  return results
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
