import { describe, it, expect } from 'vitest'
import { selectModel, escalate } from '@main/services/model-router'
import type { UsageSource } from '@shared/types'

const HAIKU = 'claude-haiku-4-5-20251001'
const SONNET = 'claude-sonnet-5'
const OPUS = 'claude-opus-4-8'

describe('selectModel', () => {
  it('maps every UsageSource to its base tier at a small prompt size', () => {
    const expected: Record<UsageSource, string> = {
      inference: HAIKU,
      plan_draft: HAIKU,
      routine_digest: SONNET,
      routine_setup: SONNET,
      routine_chat: SONNET,
      routine_run: OPUS,
      plan_chat: SONNET,
      checkin_chat: SONNET,
      checkin_extract: SONNET,
      memory: SONNET,
      chat: SONNET,
      suggest: OPUS,
      review: SONNET,
      authoring: OPUS,
      other: SONNET
    }
    for (const [source, model] of Object.entries(expected)) {
      expect(selectModel(source as UsageSource, 100)).toBe(model)
    }
  })

  it('does not bump the tier just below the large-prompt threshold', () => {
    expect(selectModel('inference', 11_999)).toBe(HAIKU)
  })

  it('bumps one tier at the large-prompt threshold', () => {
    expect(selectModel('inference', 12_000)).toBe(SONNET)
  })

  it('does not double-bump just below the xlarge threshold', () => {
    expect(selectModel('inference', 39_999)).toBe(SONNET)
  })

  it('bumps two tiers at the xlarge threshold', () => {
    expect(selectModel('inference', 40_000)).toBe(OPUS)
  })

  it('clamps at the top of the ladder — an already-capable source never exceeds opus', () => {
    expect(selectModel('authoring', 40_000)).toBe(OPUS)
  })

  it('clamps a balanced source bumped twice to opus, not past it', () => {
    expect(selectModel('chat', 100_000)).toBe(OPUS)
  })
})

describe('escalate', () => {
  it('returns the next-stronger model in the ladder', () => {
    expect(escalate(HAIKU)).toBe(SONNET)
    expect(escalate(SONNET)).toBe(OPUS)
  })

  it('returns null at the top of the ladder', () => {
    expect(escalate(OPUS)).toBeNull()
  })

  it('returns null for an unknown model id', () => {
    expect(escalate('not-a-real-model')).toBeNull()
  })
})
