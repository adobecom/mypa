import { describe, it, expect, vi } from 'vitest'
import type { ChatMessage } from '@shared/types'

// ambient.ts is the orchestration hub — it pulls in ~14 sibling services (db, config,
// scope, mcp, ingestion, memory-graph, triggers, inference, claude, embeddings,
// memories, budget, autonomy, tray, windows) purely to wire the ambient pipeline.
// isAffirmative/isDismissal/findLatestPendingAction are pure regex/array-scan helpers
// with zero dependency on any of that — every import below is a mechanical no-op stub
// so the module can load without pulling in real DB/network/process code.
vi.mock('@main/db/index', () => ({
  dbCreateIntent: vi.fn(),
  dbGetIntent: vi.fn(),
  dbGetPendingIntents: vi.fn(),
  dbGetResolvedIntentsSince: vi.fn(),
  dbGetAllIntents: vi.fn(),
  dbUpdateIntentStatus: vi.fn(),
  dbSetIntentChallengeReason: vi.fn(),
  dbUpdateIntentPayload: vi.fn(),
  dbUpdateIntentActions: vi.fn(),
  dbCreateAmbientActionRecord: vi.fn(),
  dbAppendActionLog: vi.fn(),
  dbGetAllPolicies: vi.fn(),
  dbUpsertNode: vi.fn(),
  dbBumpNodeWeight: vi.fn(),
  dbUpsertEdge: vi.fn(),
  dbReproposeIntent: vi.fn(),
  dbGetNodeById: vi.fn(),
  dbGetSignalByExternal: vi.fn(),
  dbGetDirectedSignals: vi.fn(),
  dbAddIntentChatMessage: vi.fn(),
  dbGetIntentChatThread: vi.fn(),
  dbUpdateIntentChatMessageMetadata: vi.fn(),
  dbGetPlanThread: vi.fn(),
  dbUpdatePlanMessageMetadata: vi.fn(),
  dbGetNode: vi.fn()
}))
vi.mock('@main/services/config', () => ({ readConfig: vi.fn(), targetIsOwner: vi.fn() }))
vi.mock('@main/services/scope', () => ({ violatesScope: vi.fn() }))
vi.mock('@main/services/mcp', () => ({ callTool: vi.fn(), getToolInputSchema: vi.fn(), ensureServersConnected: vi.fn() }))
vi.mock('@main/services/ingestion', () => ({
  startIngestion: vi.fn(),
  stopIngestion: vi.fn(),
  pollOnce: vi.fn(),
  getLastCompletePollAt: vi.fn()
}))
vi.mock('@main/services/memory-graph', () => ({
  ingestSignalIntoGraph: vi.fn(),
  assembleContextPacket: vi.fn(),
  startDecayTimer: vi.fn(),
  stopDecayTimer: vi.fn(),
  renderPacketForPrompt: vi.fn(),
  deriveWikilinkEdges: vi.fn()
}))
vi.mock('@main/services/triggers', () => ({
  evalEventTriggers: vi.fn(),
  evalTime: vi.fn(),
  coalesceHits: vi.fn(),
  evalWaitingOnMeFromGraph: vi.fn(),
  evalStaleAndMine: vi.fn(),
  isDeepEligible: vi.fn()
}))
vi.mock('@main/services/inference', () => ({ inferIntent: vi.fn(), inferDeepIntent: vi.fn(), reproposeIntent: vi.fn() }))
vi.mock('@main/services/claude', () => ({ streamChat: vi.fn(), cancelStream: vi.fn() }))
vi.mock('@main/services/embeddings', () => ({ enqueueEmbeddings: vi.fn(), enqueueBackfill: vi.fn(), enqueueMemoryBackfill: vi.fn() }))
vi.mock('@main/services/memories', () => ({ runMemorySummarization: vi.fn() }))
vi.mock('@main/services/budget', () => ({ isOverDailyBudget: vi.fn() }))
vi.mock('@main/services/autonomy', () => ({
  resolveTier: vi.fn(),
  shouldAutoExecute: vi.fn(),
  isMuted: vi.fn(),
  actionTypeOf: vi.fn(),
  recordApproval: vi.fn(),
  recordChallenge: vi.fn(),
  recordDismissal: vi.fn(),
  recordExecution: vi.fn(),
  setTier: vi.fn(),
  resetTrust: vi.fn()
}))
vi.mock('@main/tray', () => ({ setTrayState: vi.fn() }))
vi.mock('@main/windows', () => ({ broadcast: vi.fn(), updateBadgeCount: vi.fn() }))

const { isAffirmative, isDismissal, findLatestPendingAction } = await import('@main/services/ambient')

function msg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    content: '',
    timestamp: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

describe('isAffirmative', () => {
  it('recognizes common short affirmatives', () => {
    for (const text of ['yes', 'go ahead', 'do it', 'approve', 'ship it', 'Yes.', '  approve it  ']) {
      expect(isAffirmative(text)).toBe(true)
    }
  })

  it('rejects longer or unrelated messages', () => {
    expect(isAffirmative('yes, but change the wording first')).toBe(false)
    expect(isAffirmative('what does this do?')).toBe(false)
    expect(isAffirmative('')).toBe(false)
  })
})

describe('isDismissal', () => {
  it('recognizes common short dismissals', () => {
    for (const text of ['no', 'cancel', "don't", 'dismiss', 'nevermind', 'stop']) {
      expect(isDismissal(text)).toBe(true)
    }
  })

  it('rejects an affirmative or unrelated message', () => {
    expect(isDismissal('yes')).toBe(false)
    expect(isDismissal('no wait, actually yes')).toBe(false)
  })
})

describe('findLatestPendingAction', () => {
  it('returns null for an empty thread', () => {
    expect(findLatestPendingAction([])).toBeNull()
  })

  it('returns null when no message has a pending action', () => {
    const thread = [msg({ id: 'a' }), msg({ id: 'b', action: { status: 'executed' } as any })]
    expect(findLatestPendingAction(thread)).toBeNull()
  })

  it('returns the most recent pending-action message', () => {
    const thread = [
      msg({ id: 'a', action: { status: 'pending' } as any }),
      msg({ id: 'b' }),
      msg({ id: 'c', action: { status: 'pending' } as any })
    ]
    expect(findLatestPendingAction(thread)?.id).toBe('c')
  })

  it('finds an earlier pending action even when the last message has a resolved one', () => {
    // findLatestPendingAction itself scans the whole thread backward for any pending
    // action — the "must be the very last message" gate (avoiding a stale approval on
    // an older chip) is applied separately by the caller in ambient.ts, not here.
    const thread = [
      msg({ id: 'a', action: { status: 'pending' } as any }),
      msg({ id: 'b', action: { status: 'dismissed' } as any })
    ]
    expect(findLatestPendingAction(thread)?.id).toBe('a')
  })
})
