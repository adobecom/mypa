import type { UsageSource } from '@shared/types'

// ─── Tier ladder (weakest → strongest) ───────────────────────────────────────

const TIERS: readonly string[] = [
  'claude-haiku-4-5-20251001',
  'claude-sonnet-5',
  'claude-opus-4-8',
]

type Tier = 'fast' | 'balanced' | 'capable'

const TIER_MODEL: Record<Tier, string> = {
  fast:     'claude-haiku-4-5-20251001',
  balanced: 'claude-sonnet-5',
  capable:  'claude-opus-4-8',
}

// ─── Base tier per task ───────────────────────────────────────────────────────

// Rationale:
//   fast     — short structured classification; minimal reasoning required
//   balanced — summarization, extraction, multi-turn chat; moderate reasoning
//   capable  — multi-round agentic MCP tool use; needs full reasoning power

// Use Record (not Partial) so TypeScript enforces exhaustive coverage —
// a new UsageSource that isn't mapped here is a compile error, not a silent fallback.
const SOURCE_TIER: Record<UsageSource, Tier> = {
  inference:       'fast',
  plan_draft:      'fast',
  routine_digest:  'balanced',
  routine_setup:   'balanced',
  routine_chat:    'balanced',
  // Scheduled routine runs chain multiple MCP tool calls agentically (list →
  // per-item detail fetches) — same reasoning demand as 'suggest'/'authoring'.
  routine_run:     'capable',
  plan_chat:       'balanced',
  checkin_chat:    'balanced',
  checkin_extract: 'balanced',
  memory:          'balanced',
  chat:            'balanced',
  suggest:         'capable',
  // 'review' (ambient deep-enrichment) used to be 'capable' (Opus) and ran
  // unattended on a background heartbeat — it accounted for ~97% of Opus
  // spend. Downgraded to 'balanced' (Sonnet); still bumps to 'capable' via
  // the size thresholds below for genuinely large context packets.
  review:          'balanced',
  // Code authoring is user-initiated (approve-to-start) and runs at most once per
  // approved intent, so unlike 'review' it does not run unattended on a heartbeat —
  // the cost/quality tradeoff favors the strongest tier here.
  authoring:       'capable',
  other:           'balanced',
}

// ─── Size thresholds ──────────────────────────────────────────────────────────

// Large prompts (big routine digests, long chat threads) bump up one tier;
// very large prompts bump two tiers — clamped to 'capable'.

const CHARS_LARGE   = 12_000
const CHARS_XLARGE  = 40_000

// ─── Exports ──────────────────────────────────────────────────────────────────

/**
 * Choose the right Claude model for a task.
 *
 * Base tier comes from the task's UsageSource label; a large prompt bumps
 * the tier up toward 'capable' to avoid under-provisioning on heavy inputs.
 */
export function selectModel(source: UsageSource, promptChars: number): string {
  const tier: Tier = SOURCE_TIER[source]
  let idx = TIERS.indexOf(TIER_MODEL[tier])

  if (promptChars >= CHARS_XLARGE) {
    idx += 2
  } else if (promptChars >= CHARS_LARGE) {
    idx += 1
  }

  // Clamp to ladder bounds
  return TIERS[Math.min(idx, TIERS.length - 1)]
}

/**
 * Return the next-stronger model in the tier ladder, or null if already at
 * the top tier. Used to escalate when a task proves too hard for its
 * initially-selected model.
 */
export function escalate(modelId: string): string | null {
  const idx = TIERS.indexOf(modelId)
  if (idx < 0 || idx >= TIERS.length - 1) return null
  return TIERS[idx + 1]
}
