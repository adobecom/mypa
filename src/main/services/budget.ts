import { dbGetUsageSummary } from '../db/index'
import { readConfig } from './config'
import { DEFAULT_CONFIG } from '@shared/types'
import { logError } from './logger'

// ─── Daily spend guard ────────────────────────────────────────────────────────
// Gates optional, expensive background work (ambient deep-enrichment) against
// a configured daily USD cap. Never gates user-initiated calls (chat, plan,
// routine setup) — those always run regardless of spend.

/**
 * True once today's total usage cost (all sources, all models) has reached
 * the configured `ambient.dailyBudgetUsd` cap. A cap of 0 (or unset via
 * config override) disables the check. Errors are swallowed and treated as
 * "under budget" — a DB hiccup here must never block the ambient cycle.
 */
export function isOverDailyBudget(): boolean {
  try {
    const cap = readConfig().ambient?.dailyBudgetUsd ?? DEFAULT_CONFIG.ambient?.dailyBudgetUsd ?? 0
    if (!cap || cap <= 0) return false
    const spentToday = dbGetUsageSummary('today').total_cost
    return spentToday >= cap
  } catch (err) {
    logError('budget', 'isOverDailyBudget check failed', err)
    return false
  }
}
