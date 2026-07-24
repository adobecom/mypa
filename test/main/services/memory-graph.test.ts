import { describe, it, expect, vi } from 'vitest'
import type { ContextPacket } from '@main/services/memory-graph'
import type { GraphNode } from '@shared/types'

// memory-graph.ts pulls in config.ts (fs + electron safeStorage) via
// getOwnerHandles/readConfig. Mocking config keeps renderPacketForPrompt hermetic —
// without this it would do a real fs.readFileSync against ~/.mypa/config.json.
vi.mock('@main/services/config', () => ({
  readConfig: vi.fn(),
  getOwnerHandles: vi.fn(() => [] as string[])
}))

const { kindToNodeType, sanitizeLabel, renderPacketForPrompt } = await import('@main/services/memory-graph')
const configMock = await import('@main/services/config')

function node(overrides: Partial<GraphNode>): GraphNode {
  return {
    id: 'n1',
    type: 'issue',
    key: 'github:issue:1',
    label: 'label',
    attrs: {},
    weight: 1,
    first_seen: '2026-01-01T00:00:00.000Z',
    last_seen: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

function emptyPacket(overrides: Partial<ContextPacket> = {}): ContextPacket {
  return {
    triggerKind: 'waiting',
    focusNodes: [],
    relatedEdges: [],
    recentSignals: [],
    topByWeight: [],
    semanticSignals: [],
    memories: [],
    ...overrides
  }
}

describe('kindToNodeType', () => {
  it('maps known signal kinds to their node type', () => {
    expect(kindToNodeType('pull_request')).toBe('pull_request')
    expect(kindToNodeType('issue')).toBe('issue')
    expect(kindToNodeType('message')).toBe('message')
    expect(kindToNodeType('note')).toBe('document')
  })

  it('falls back to issue for an unknown kind', () => {
    expect(kindToNodeType('something-unrecognized')).toBe('issue')
  })
})

describe('sanitizeLabel', () => {
  it('replaces angle brackets with lookalike characters', () => {
    expect(sanitizeLabel('<script>alert(1)</script>')).toBe('‹script›alert(1)‹/script›')
  })

  it('clamps to the default max length of 200', () => {
    const long = 'x'.repeat(300)
    expect(sanitizeLabel(long).length).toBe(200)
  })

  it('respects a custom max length', () => {
    expect(sanitizeLabel('hello world', 5)).toBe('hello')
  })

  it('leaves ordinary text untouched (aside from clamping)', () => {
    expect(sanitizeLabel('PR #482: fix the thing')).toBe('PR #482: fix the thing')
  })
})

describe('renderPacketForPrompt', () => {
  it('renders memories first, then trigger, when present', () => {
    vi.mocked(configMock.getOwnerHandles).mockReturnValue([])
    const packet = emptyPacket({
      triggerKind: 'spike',
      memories: [
        { id: 'm1', content: 'User prefers terse PR comments' } as any
      ]
    })
    const out = renderPacketForPrompt(packet)
    expect(out).toContain('Known facts (distilled from past activity):')
    expect(out).toContain('User prefers terse PR comments')
    expect(out).toContain('Trigger: spike')
  })

  it('omits sections whose data is empty', () => {
    const out = renderPacketForPrompt(emptyPacket())
    expect(out).not.toContain('Focus items:')
    expect(out).not.toContain('Relationships:')
    expect(out).not.toContain('Most active items recently:')
    expect(out).not.toContain('Recent signals')
    expect(out).not.toContain('Related items')
  })

  it('labels a focus node matching an owner handle as "you (<label>)"', () => {
    vi.mocked(configMock.getOwnerHandles).mockReturnValue(['octocat'])
    const packet = emptyPacket({ focusNodes: [node({ label: 'octocat' })] })
    const out = renderPacketForPrompt(packet)
    expect(out).toContain('you (octocat)')
  })

  it('does not tag a non-owner node', () => {
    vi.mocked(configMock.getOwnerHandles).mockReturnValue(['octocat'])
    const packet = emptyPacket({ focusNodes: [node({ label: 'someone-else' })] })
    const out = renderPacketForPrompt(packet)
    expect(out).not.toContain('you (')
    expect(out).toContain('someone-else')
  })

  it('sanitizes focus-node labels and urls', () => {
    vi.mocked(configMock.getOwnerHandles).mockReturnValue([])
    const packet = emptyPacket({
      focusNodes: [node({ label: '<inject>', attrs: { url: 'https://x/<y>' } })]
    })
    const out = renderPacketForPrompt(packet)
    expect(out).not.toContain('<inject>')
    expect(out).toContain('‹inject›')
    expect(out).not.toContain('<y>')
  })
})
