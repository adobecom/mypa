import { dbInsertUsage } from '../db/index'
import { logError } from './logger'
import type { UsageSource } from '@shared/types'

// ─── Usage recorder ───────────────────────────────────────────────────────────
// Thin wrapper so claude.ts never imports the DB layer directly.
// All errors are swallowed — telemetry must never break a Claude call.

export interface CliUsage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

export interface CliResult {
  usage?: CliUsage
  total_cost_usd?: number
  cost_usd?: number
}

export function recordUsage(
  source: UsageSource,
  model: string,
  cliResult: CliResult
): void {
  try {
    const u = cliResult.usage ?? {}
    dbInsertUsage({
      source,
      model,
      input_tokens: u.input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      cache_creation_tokens: u.cache_creation_input_tokens ?? 0,
      cache_read_tokens: u.cache_read_input_tokens ?? 0,
      cost_usd: cliResult.total_cost_usd ?? cliResult.cost_usd ?? 0
    })
  } catch (err) {
    // Never let telemetry break a call, but a silent failure here means
    // cost/usage numbers under-report with no trace — always log it.
    logError('usage', 'recordUsage failed', err)
  }
}
