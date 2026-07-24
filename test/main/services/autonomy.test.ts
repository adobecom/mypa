import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { IntentObject, AutonomyPolicy } from '@shared/types'

// autonomy.ts's only runtime dependency is ../db/index — mock it entirely so
// resolveTier/recordApproval/recordChallenge can be tested without a real database.
vi.mock('@main/db/index', () => ({
  dbGetPolicy: vi.fn(),
  dbUpsertPolicy: vi.fn(),
  dbRecordPolicyOutcome: vi.fn(),
  dbUpsertNode: vi.fn(),
  dbGetNode: vi.fn(),
  dbBumpNodeWeight: vi.fn(),
  dbUpsertEdge: vi.fn(),
  getDb: vi.fn()
}))

const {
  actionTypeOf,
  resolveTier,
  shouldAutoExecute,
  isMuted,
  recordApproval,
  recordChallenge
} = await import('@main/services/autonomy')
const db = await import('@main/db/index')

function intent(overrides: Partial<IntentObject> = {}): IntentObject {
  return {
    type: 'action',
    confidence: 0.8,
    urgency: 0.6,
    proposed_action: { surface: 'github', verb: 'comment', target: 'PR #1', payload: {} },
    rationale: 'test',
    reversibility: 'reversible',
    required_approval: false,
    ...overrides
  }
}

function policy(overrides: Partial<AutonomyPolicy> = {}): AutonomyPolicy {
  return {
    action_type: 'github:comment',
    tier: 2,
    tier_locked: false,
    approvals: 0,
    consecutive_approvals: 0,
    challenges: 0,
    dismissals: 0,
    executions: 0,
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('actionTypeOf', () => {
  it('keys on server:tool when actions[] is present', () => {
    const obj = intent({ actions: [{ server: 'github', tool: 'add_issue_comment', params: {} }] })
    expect(actionTypeOf(obj)).toBe('github:add_issue_comment')
  })

  it('falls back to surface:verb for legacy intents', () => {
    expect(actionTypeOf(intent())).toBe('github:comment')
  })
})

describe('shouldAutoExecute', () => {
  it('is true only for tier 0', () => {
    expect(shouldAutoExecute(0)).toBe(true)
    expect(shouldAutoExecute(1)).toBe(false)
    expect(shouldAutoExecute(2)).toBe(false)
    expect(shouldAutoExecute(3)).toBe(false)
  })
})

describe('isMuted', () => {
  it('mutes informational intents at tier 3', () => {
    expect(isMuted('flag', 3)).toBe(true)
    expect(isMuted('digest', 3)).toBe(true)
    expect(isMuted('suggestion', 3)).toBe(true)
  })

  it('never mutes action intents, even at tier 3 (Locked, not muted)', () => {
    expect(isMuted('action', 3)).toBe(false)
  })

  it('does not mute informational intents below tier 3', () => {
    expect(isMuted('flag', 1)).toBe(false)
  })
})

describe('resolveTier', () => {
  it('uses the surface:verb policy tier when set', () => {
    vi.mocked(db.dbGetPolicy).mockImplementation((key: string) =>
      key === 'github:comment' ? policy({ tier: 1 }) : null
    )
    expect(resolveTier(intent())).toBe(1)
  })

  it('falls back to the type policy when no surface policy exists', () => {
    vi.mocked(db.dbGetPolicy).mockImplementation((key: string) =>
      key === 'action' ? policy({ tier: 1 }) : null
    )
    expect(resolveTier(intent())).toBe(1)
  })

  it('falls back to the type-aware default when neither policy exists', () => {
    vi.mocked(db.dbGetPolicy).mockReturnValue(null)
    expect(resolveTier(intent({ type: 'flag', proposed_action: { surface: 'github', verb: 'none', target: 't', payload: {} } }))).toBe(1)
  })

  it('falls back to the hardcoded default (2) for an action with no policy', () => {
    vi.mocked(db.dbGetPolicy).mockReturnValue(null)
    expect(resolveTier(intent())).toBe(2)
  })

  it('floors irreversible actions at tier 2 regardless of policy', () => {
    vi.mocked(db.dbGetPolicy).mockImplementation((key: string) =>
      key === 'github:comment' ? policy({ tier: 0 }) : null
    )
    expect(resolveTier(intent({ reversibility: 'irreversible' }))).toBe(2)
  })

  it('floors required_approval actions at tier 2 regardless of policy', () => {
    vi.mocked(db.dbGetPolicy).mockImplementation((key: string) =>
      key === 'github:comment' ? policy({ tier: 0 }) : null
    )
    expect(resolveTier(intent({ required_approval: true }))).toBe(2)
  })

  it('floors a destructive-tool-name action at tier 2 even when policy grants tier 0', () => {
    // The heuristic matches whole words only (\b...\b) — "merge" must be its own
    // token, not joined into a longer snake_case tool name like "merge_pull_request"
    // (underscore is a word character, so no boundary forms after "merge" there).
    vi.mocked(db.dbGetPolicy).mockImplementation((key: string) =>
      key === 'github:merge' ? policy({ tier: 0 }) : null
    )
    const obj = intent({ actions: [{ server: 'github', tool: 'merge', params: {} }] })
    expect(resolveTier(obj)).toBe(2)
  })

  it('does NOT floor a destructive word when it is joined into a snake_case tool name', () => {
    // Documents a real gap in the heuristic: MCP tool names are conventionally
    // snake_case (e.g. "merge_pull_request"), so \b(merge|...)\b never matches them —
    // the destructive-word safety net only fires for standalone tool names.
    vi.mocked(db.dbGetPolicy).mockImplementation((key: string) =>
      key === 'github:merge_pull_request' ? policy({ tier: 0 }) : null
    )
    const obj = intent({ actions: [{ server: 'github', tool: 'merge_pull_request', params: {} }] })
    expect(resolveTier(obj)).toBe(0)
  })

  it('does not floor a non-destructive generic action', () => {
    vi.mocked(db.dbGetPolicy).mockImplementation((key: string) =>
      key === 'github:add_issue_comment' ? policy({ tier: 0 }) : null
    )
    const obj = intent({ actions: [{ server: 'github', tool: 'add_issue_comment', params: {} }] })
    expect(resolveTier(obj)).toBe(0)
  })

  it('tier 3 (locked) is absolute — overrides any safety floor', () => {
    vi.mocked(db.dbGetPolicy).mockImplementation((key: string) =>
      key === 'github:comment' ? policy({ tier: 3, tier_locked: true }) : null
    )
    expect(resolveTier(intent())).toBe(3)
  })
})

describe('recordApproval trust math', () => {
  it('lowers the tier by one after 5 consecutive approvals', () => {
    vi.mocked(db.dbRecordPolicyOutcome).mockReturnValue(
      policy({ tier: 2, consecutive_approvals: 5 })
    )
    recordApproval('github:comment')
    expect(db.dbUpsertPolicy).toHaveBeenCalledWith('github:comment', { tier: 1, consecutive_approvals: 0 })
  })

  it('does not lower the tier before the 5th consecutive approval', () => {
    vi.mocked(db.dbRecordPolicyOutcome).mockReturnValue(
      policy({ tier: 2, consecutive_approvals: 4 })
    )
    recordApproval('github:comment')
    expect(db.dbUpsertPolicy).not.toHaveBeenCalled()
  })

  it('never lowers below the auto-decay floor (tier 1)', () => {
    vi.mocked(db.dbRecordPolicyOutcome).mockReturnValue(
      policy({ tier: 1, consecutive_approvals: 5 })
    )
    recordApproval('github:comment')
    expect(db.dbUpsertPolicy).not.toHaveBeenCalled()
  })

  it('does nothing when the policy is locked', () => {
    vi.mocked(db.dbRecordPolicyOutcome).mockReturnValue(
      policy({ tier: 2, tier_locked: true, consecutive_approvals: 5 })
    )
    recordApproval('github:comment')
    expect(db.dbUpsertPolicy).not.toHaveBeenCalled()
  })
})

describe('recordChallenge trust math', () => {
  it('raises the tier by one, capped at the escalate ceiling (2)', () => {
    vi.mocked(db.dbRecordPolicyOutcome).mockReturnValue(policy({ tier: 1 }))
    recordChallenge('github:comment', '')
    expect(db.dbUpsertPolicy).toHaveBeenCalledWith('github:comment', { tier: 2 })
  })

  it('does not raise past tier 2 (Locked requires explicit opt-in)', () => {
    vi.mocked(db.dbRecordPolicyOutcome).mockReturnValue(policy({ tier: 2 }))
    recordChallenge('github:comment', '')
    expect(db.dbUpsertPolicy).not.toHaveBeenCalled()
  })

  it('does not raise a locked policy', () => {
    vi.mocked(db.dbRecordPolicyOutcome).mockReturnValue(policy({ tier: 1, tier_locked: true }))
    recordChallenge('github:comment', '')
    expect(db.dbUpsertPolicy).not.toHaveBeenCalled()
  })

  it('writes a preference node and edge when feedback is non-empty', () => {
    vi.mocked(db.dbRecordPolicyOutcome).mockReturnValue(policy({ tier: 1 }))
    vi.mocked(db.dbUpsertNode).mockReturnValue({ id: 'pref-node-id' } as any)
    vi.mocked(db.dbGetNode).mockReturnValue(null)
    recordChallenge('github:comment', 'be less chatty')
    expect(db.dbUpsertNode).toHaveBeenCalled()
    expect(db.dbBumpNodeWeight).toHaveBeenCalledWith('pref-node-id', 3.0)
    expect(db.dbUpsertEdge).toHaveBeenCalled()
  })

  it('skips the preference write when feedback is blank', () => {
    vi.mocked(db.dbRecordPolicyOutcome).mockReturnValue(policy({ tier: 1 }))
    recordChallenge('github:comment', '   ')
    expect(db.dbUpsertNode).not.toHaveBeenCalled()
  })
})
