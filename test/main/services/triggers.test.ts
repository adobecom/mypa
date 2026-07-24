import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Signal, GraphNode, GraphEdge } from '@shared/types'

vi.mock('@main/db/index', () => ({
  dbCountSignalsSince: vi.fn(),
  dbGetDependencyEdges: vi.fn(),
  dbGetTopNodesByWeight: vi.fn(),
  dbGetNode: vi.fn(),
  dbGetDirectedSignals: vi.fn()
}))

// Full replacement mock — avoids loading the real memory-graph.ts (which pulls in
// config.ts/embeddings.ts). kindToNodeType mirrors the real mapping for the kinds
// exercised here so evalSpike/evalDependency's node-key derivation stays realistic.
vi.mock('@main/services/memory-graph', () => ({
  getStaleCandidates: vi.fn(),
  kindToNodeType: (kind: string) => {
    if (kind === 'pull_request') return 'pull_request'
    if (kind === 'issue') return 'issue'
    if (kind === 'message') return 'message'
    return 'issue'
  }
}))

const {
  evalSpike,
  evalStaleAndMine,
  evalWaitingOnMe,
  evalDependency,
  evalTime,
  isDeepEligible,
  coalesceHits
} = await import('@main/services/triggers')
const db = await import('@main/db/index')
const memoryGraph = await import('@main/services/memory-graph')

beforeEach(() => {
  vi.clearAllMocks()
})

function signal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: 's1',
    surface: 'github',
    kind: 'pull_request',
    external_id: '1',
    fingerprint: 'fp',
    title: 'A pull request',
    body: '',
    actor: 'alice',
    url: 'https://github.com/o/r/pull/1',
    raw: {},
    occurred_at: new Date().toISOString(),
    observed_at: new Date().toISOString(),
    processed: false,
    relation: null,
    directed: false,
    last_actor: null,
    due_at: null,
    last_seen_at: null,
    ...overrides
  } as Signal
}

function node(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: 'n1',
    type: 'issue',
    key: 'github:issue:1',
    label: 'l',
    attrs: {},
    weight: 1,
    first_seen: '',
    last_seen: '',
    ...overrides
  }
}

describe('isDeepEligible', () => {
  it('is true for waiting hits with review_requested/assigned/mentioned', () => {
    expect(isDeepEligible({ kind: 'waiting', focusNodeIds: [], reason: '', relation: 'review_requested' })).toBe(true)
    expect(isDeepEligible({ kind: 'waiting', focusNodeIds: [], reason: '', relation: 'assigned' })).toBe(true)
    expect(isDeepEligible({ kind: 'waiting', focusNodeIds: [], reason: '', relation: 'mentioned' })).toBe(true)
  })

  it('is false for other relations or non-waiting kinds', () => {
    expect(isDeepEligible({ kind: 'waiting', focusNodeIds: [], reason: '', relation: 'dm' })).toBe(false)
    expect(isDeepEligible({ kind: 'spike', focusNodeIds: [], reason: '', relation: 'review_requested' })).toBe(false)
  })
})

describe('coalesceHits', () => {
  it('passes through a single hit unchanged', () => {
    const hits = [{ kind: 'spike' as const, focusNodeIds: ['a'], reason: 'r1' }]
    expect(coalesceHits(hits)).toEqual(hits)
  })

  it('merges hits that share a focus node, concatenating reasons', () => {
    const merged = coalesceHits([
      { kind: 'spike', focusNodeIds: ['a', 'b'], reason: 'spike reason' },
      { kind: 'dependency', focusNodeIds: ['b', 'c'], reason: 'dep reason' }
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0].focusNodeIds.sort()).toEqual(['a', 'b', 'c'])
    expect(merged[0].reason).toBe('spike reason; dep reason')
  })

  it('keeps the highest-priority relation on merge', () => {
    const merged = coalesceHits([
      { kind: 'waiting', focusNodeIds: ['a'], reason: 'dm', relation: 'dm' },
      { kind: 'waiting', focusNodeIds: ['a'], reason: 'review', relation: 'review_requested' }
    ])
    expect(merged[0].relation).toBe('review_requested')
  })

  it('does not downgrade relation priority on merge', () => {
    const merged = coalesceHits([
      { kind: 'waiting', focusNodeIds: ['a'], reason: 'review', relation: 'review_requested' },
      { kind: 'waiting', focusNodeIds: ['a'], reason: 'dm', relation: 'dm' }
    ])
    expect(merged[0].relation).toBe('review_requested')
  })

  it('merges focus-less hits of the same kind instead of duplicating them', () => {
    const merged = coalesceHits([
      { kind: 'time', focusNodeIds: [], reason: 'morning digest' },
      { kind: 'time', focusNodeIds: [], reason: 'another time hit' }
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0].reason).toBe('morning digest; another time hit')
  })

  it('keeps unrelated hits separate', () => {
    const merged = coalesceHits([
      { kind: 'spike', focusNodeIds: ['a'], reason: 'r1' },
      { kind: 'dependency', focusNodeIds: ['z'], reason: 'r2' }
    ])
    expect(merged).toHaveLength(2)
  })
})

describe('evalSpike', () => {
  it('fires when 3+ same-surface/kind signals land within the window and the DB confirms the total', () => {
    const signals = [signal({ id: 'a' }), signal({ id: 'b' }), signal({ id: 'c' })]
    vi.mocked(db.dbCountSignalsSince).mockReturnValue(3)
    vi.mocked(db.dbGetNode).mockReturnValue(node({ id: 'focus1' }))
    const hits = evalSpike(signals)
    expect(hits).toHaveLength(1)
    expect(hits[0].kind).toBe('spike')
    expect(hits[0].focusNodeIds).toEqual(['focus1'])
  })

  it('does not fire below the spike threshold', () => {
    const signals = [signal({ id: 'a' }), signal({ id: 'b' })]
    const hits = evalSpike(signals)
    expect(hits).toHaveLength(0)
    expect(db.dbCountSignalsSince).not.toHaveBeenCalled()
  })

  it('ignores signals whose occurred_at is outside the spike window', () => {
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString() // 1h ago
    const signals = [
      signal({ id: 'a', occurred_at: old }),
      signal({ id: 'b', occurred_at: old }),
      signal({ id: 'c', occurred_at: old })
    ]
    const hits = evalSpike(signals)
    expect(hits).toHaveLength(0)
  })

  it('does not fire if the DB total falls back below threshold', () => {
    const signals = [signal({ id: 'a' }), signal({ id: 'b' }), signal({ id: 'c' })]
    vi.mocked(db.dbCountSignalsSince).mockReturnValue(1)
    const hits = evalSpike(signals)
    expect(hits).toHaveLength(0)
  })
})

describe('evalStaleAndMine', () => {
  it('returns nothing when there are no stale candidates', () => {
    vi.mocked(memoryGraph.getStaleCandidates).mockReturnValue([])
    expect(evalStaleAndMine()).toEqual([])
    expect(db.dbGetDirectedSignals).not.toHaveBeenCalled()
  })

  it('restricts stale candidates to nodes owned via assigned/review_requested signals', () => {
    const staleOwned = node({ id: 'owned', label: 'Owned item' })
    const staleNotOwned = node({ id: 'not-owned', label: 'Spectator item' })
    vi.mocked(memoryGraph.getStaleCandidates).mockReturnValue([staleOwned, staleNotOwned])
    vi.mocked(db.dbGetDirectedSignals).mockReturnValue([
      signal({ relation: 'assigned', kind: 'issue', external_id: '1' })
    ])
    vi.mocked(db.dbGetNode).mockImplementation((_type: string, key: string) =>
      key === 'github:issue:1' ? staleOwned : null
    )
    const hits = evalStaleAndMine()
    expect(hits).toHaveLength(1)
    expect(hits[0].focusNodeIds).toEqual(['owned'])
  })

  it('returns nothing when no stale node is owned', () => {
    vi.mocked(memoryGraph.getStaleCandidates).mockReturnValue([node({ id: 'x' })])
    vi.mocked(db.dbGetDirectedSignals).mockReturnValue([])
    expect(evalStaleAndMine()).toEqual([])
  })
})

describe('evalWaitingOnMe', () => {
  it('fires for a structurally-directed review_requested signal', () => {
    const sig = signal({ relation: 'review_requested', directed: true, last_actor: 'bob' })
    vi.mocked(db.dbGetNode).mockReturnValue(node({ id: 'focus' }))
    const hits = evalWaitingOnMe([sig])
    expect(hits).toHaveLength(1)
    expect(hits[0].relation).toBe('review_requested')
    expect(hits[0].reason).toContain('bob requested your review')
  })

  it('does not fire for an undirected, non-mentioned relation', () => {
    const sig = signal({ relation: 'involved', directed: false })
    expect(evalWaitingOnMe([sig])).toEqual([])
  })

  it('boosts an undirected "mentioned" signal whose text matches a request pattern', () => {
    const sig = signal({ relation: 'mentioned', directed: false, title: 'can you take a look?', body: '' })
    vi.mocked(db.dbGetNode).mockReturnValue(node({ id: 'focus' }))
    expect(evalWaitingOnMe([sig])).toHaveLength(1)
  })

  it('does not boost an undirected "mentioned" signal with no request pattern', () => {
    const sig = signal({ relation: 'mentioned', directed: false, title: 'fyi, deployed', body: '' })
    expect(evalWaitingOnMe([sig])).toEqual([])
  })

  it('caps at 3 hits per cycle', () => {
    vi.mocked(db.dbGetNode).mockReturnValue(node({ id: 'focus' }))
    const signals = Array.from({ length: 5 }, (_, i) =>
      signal({ id: `s${i}`, relation: 'assigned', directed: true })
    )
    expect(evalWaitingOnMe(signals)).toHaveLength(3)
  })
})

describe('evalDependency', () => {
  it('fires when a new signal touches a node in a dependency edge', () => {
    const edges: GraphEdge[] = [
      { id: 'e1', src_id: 'n1', dst_id: 'n2', rel: 'blocked_by', weight: 1, attrs: {}, first_seen: '', last_seen: '' }
    ]
    vi.mocked(db.dbGetDependencyEdges).mockReturnValue(edges)
    vi.mocked(db.dbGetNode).mockReturnValue(node({ id: 'n1' }))
    const hits = evalDependency([signal()])
    expect(hits).toHaveLength(1)
    expect(hits[0].focusNodeIds.sort()).toEqual(['n1', 'n2'])
  })

  it('returns nothing when there are no dependency edges', () => {
    vi.mocked(db.dbGetDependencyEdges).mockReturnValue([])
    expect(evalDependency([signal()])).toEqual([])
    expect(db.dbGetNode).not.toHaveBeenCalled()
  })

  it('returns nothing when the signal node does not participate in any edge', () => {
    const edges: GraphEdge[] = [
      { id: 'e1', src_id: 'other1', dst_id: 'other2', rel: 'blocked_by', weight: 1, attrs: {}, first_seen: '', last_seen: '' }
    ]
    vi.mocked(db.dbGetDependencyEdges).mockReturnValue(edges)
    vi.mocked(db.dbGetNode).mockReturnValue(node({ id: 'n1' }))
    expect(evalDependency([signal()])).toEqual([])
  })

  it('returns nothing for an empty signal list', () => {
    expect(evalDependency([])).toEqual([])
    expect(db.dbGetDependencyEdges).not.toHaveBeenCalled()
  })
})

describe('evalTime', () => {
  it('returns a time hit referencing the top-weighted nodes', () => {
    vi.mocked(db.dbGetTopNodesByWeight).mockReturnValue([node({ id: 'a' }), node({ id: 'b' })])
    const hits = evalTime('morning')
    expect(hits).toHaveLength(1)
    expect(hits[0].kind).toBe('time')
    expect(hits[0].reason).toContain('morning')
    expect(hits[0].focusNodeIds).toEqual(['a', 'b'])
  })
})
