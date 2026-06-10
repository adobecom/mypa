import {
  dbGetPolicy,
  dbUpsertPolicy,
  dbRecordPolicyOutcome,
  dbUpsertNode,
  dbGetNode,
  dbBumpNodeWeight,
  dbUpsertEdge,
  getDb
} from '../db/index'
import type { IntentObject, IntentType, Tier } from '@shared/types'

// ─── Action type key ──────────────────────────────────────────────────────────

export function actionTypeOf(obj: IntentObject): string {
  return `${obj.proposed_action.surface}:${obj.proposed_action.verb}`
}

// ─── Tier resolution ──────────────────────────────────────────────────────────
// Tier 0 = silent action (auto-execute, no notification)
// Tier 1 = surfaced suggestion (show, no explicit approval needed)
// Tier 2 = explicit approval required
// Tier 3 = locked — always user-initiated, agent never acts

const DEFAULT_TIER: Tier = 2

// Informational intent types that don't require user approval by default.
// These surface as notifications (tier 1) rather than approval requests (tier 2).
const TYPE_DEFAULT_TIER: Partial<Record<string, Tier>> = {
  action: 2,
  suggestion: 1,
  flag: 1,
  digest: 1,
}

export function resolveTier(obj: IntentObject): Tier {
  const actionType = actionTypeOf(obj)

  // Two-level lookup:
  // 1. Earned per-surface:verb policy (granular, from approve/challenge interactions)
  // 2. Intent-type default set by the user in Settings (e.g. 'action', 'suggestion')
  // 3. Type-aware default (flag/suggestion → 1, action → 2)
  // 4. Hardcoded DEFAULT_TIER
  const surfacePolicy = dbGetPolicy(actionType)
  const typePolicy = dbGetPolicy(obj.type)
  let tier: Tier = surfacePolicy?.tier ?? typePolicy?.tier ?? TYPE_DEFAULT_TIER[obj.type] ?? DEFAULT_TIER

  // Safety floor: irreversible or required_approval actions can never be below tier 2
  if (obj.reversibility === 'irreversible' || obj.required_approval) {
    if (tier < 2) tier = 2
  }

  // Tier 3 (locked) is absolute at either level
  if (surfacePolicy?.tier === 3 || typePolicy?.tier === 3) tier = 3

  return tier
}

export function shouldAutoExecute(tier: Tier): boolean {
  return tier === 0
}

// Informational intents (flag/digest/suggestion) at tier 3 are "muted": suppressed
// entirely so they never appear in any UI surface. For action intents, tier 3 means
// "Locked" (surfaced as a read-only flag, never executed) — a distinct, different
// semantic.
export function isMuted(type: IntentType, tier: Tier): boolean {
  return type !== 'action' && tier === 3
}

// ─── Trust accumulation ───────────────────────────────────────────────────────
// After K *consecutive* approvals (reset by any challenge or dismissal), drop tier 2→1.
// Tier 1 is the automatic decay floor — reaching tier 0 requires explicit user opt-in.
// Challenge raises tier back up and writes a preference signal into the graph.

const CONSECUTIVE_APPROVALS_TO_LOWER = 5
// The minimum tier that automatic trust accumulation can reach.
// Tier 0 (silent auto-execute) requires explicit user opt-in via settings, never just approvals.
const AUTO_DECAY_FLOOR: Tier = 1

export function recordApproval(actionType: string): void {
  const policy = dbRecordPolicyOutcome(actionType, 'approval')

  // Don't lower tier if locked, already at floor or below, or locked at tier 3
  if (policy.tier_locked || policy.tier <= AUTO_DECAY_FLOOR || policy.tier === 3) return

  // Use consecutive_approvals (reset on challenge/dismissal) for accurate streak tracking.
  // Reset the streak when lowering so each subsequent tier step also costs CONSECUTIVE_APPROVALS_TO_LOWER.
  if (policy.consecutive_approvals >= CONSECUTIVE_APPROVALS_TO_LOWER) {
    const newTier = Math.max(AUTO_DECAY_FLOOR, policy.tier - 1) as Tier
    dbUpsertPolicy(actionType, { tier: newTier, consecutive_approvals: 0 })
    console.log(`[autonomy] trust raised for ${actionType}: tier ${policy.tier} → ${newTier}`)
  }
}

export function recordChallenge(actionType: string, feedback: string): void {
  const policy = dbRecordPolicyOutcome(actionType, 'challenge')

  // Raise tier on challenge (don't lock — user can earn trust back)
  if (!policy.tier_locked && policy.tier < 3) {
    const newTier = Math.min(3, policy.tier + 1) as Tier
    dbUpsertPolicy(actionType, { tier: newTier })
    console.log(`[autonomy] trust lowered for ${actionType}: tier ${policy.tier} → ${newTier}`)
  }

  // Write the feedback as a preference signal into the memory graph
  // so future context packets carry "user pushed back on X"
  if (feedback.trim()) {
    const prefKey = `preference:${actionType}`
    const prefNode = dbUpsertNode('decision', prefKey, `Preference: ${actionType}`, {
      feedback: feedback.slice(0, 500),
      actionType
    })
    // Bump weight so it surfaces in future context packets
    dbBumpNodeWeight(prefNode.id, 3.0)

    // Link preference to action type (deferred edge)
    const actionKey = `action:${actionType}`
    const actionNode = dbGetNode('decision', actionKey) ??
      dbUpsertNode('decision', actionKey, actionType)
    dbUpsertEdge(prefNode.id, actionNode.id, 'deferred', 2.0)
  }
}

export function recordDismissal(actionType: string): void {
  dbRecordPolicyOutcome(actionType, 'dismissal')
  // Dismissal doesn't automatically change tier — it's neutral
}

export function recordExecution(actionType: string): void {
  dbRecordPolicyOutcome(actionType, 'execution')
}

// ─── Policy management ────────────────────────────────────────────────────────

export function setTier(actionType: string, tier: Tier, locked = false): void {
  dbUpsertPolicy(actionType, { tier, tier_locked: locked })
}

export function resetTrust(): void {
  // Delete all policy rows — each action_type reverts to the DEFAULT_TIER on next use
  getDb().prepare('DELETE FROM autonomy_policy').run()
  console.log('[autonomy] trust reset to conservative defaults')
}
