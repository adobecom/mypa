import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/types'
import type { AppConfig } from '@shared/types'

// config.ts reads ~/.mypa/config.json via `fs` and decrypts secrets via electron's
// safeStorage (globally mocked in test/setup.ts). Mocking `fs` lets each test control
// exactly what readConfig() sees without touching the real filesystem, and mocking
// '@main/db/index' controls dbGetActiveHardMemories for buildDirectivesClause.
vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
  appendFileSync: vi.fn(),
  statSync: vi.fn()
}))
vi.mock('@main/db/index', () => ({
  dbGetActiveHardMemories: vi.fn(() => [])
}))

const fs = await import('fs')
const db = await import('@main/db/index')
const { buildOwnerClause, buildDirectivesClause, targetIsOwner, getOwnerHandles } =
  await import('@main/services/config')

function withConfig(partial: Partial<AppConfig>): void {
  const cfg: AppConfig = { ...DEFAULT_CONFIG, ...partial }
  vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(cfg))
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(fs.existsSync).mockReturnValue(true)
  vi.mocked(db.dbGetActiveHardMemories).mockReturnValue([])
})

describe('getOwnerHandles', () => {
  it('flattens comma-separated handles across surfaces', () => {
    withConfig({ owner: { name: 'Ada', handles: { github: 'ada, ada-bot', slack: 'ada.l' } } })
    expect(getOwnerHandles().sort()).toEqual(['ada', 'ada-bot', 'ada.l'])
  })

  it('returns an empty array when no owner is configured', () => {
    withConfig({})
    expect(getOwnerHandles()).toEqual([])
  })
})

describe('targetIsOwner', () => {
  it('matches the owner name case-insensitively', () => {
    withConfig({ owner: { name: 'Ada Lovelace' } })
    expect(targetIsOwner('ada lovelace')).toBe(true)
    expect(targetIsOwner('ADA LOVELACE')).toBe(true)
  })

  it('matches a handle with a leading @ stripped', () => {
    withConfig({ owner: { handles: { slack: 'ada' } } })
    expect(targetIsOwner('@ada')).toBe(true)
  })

  it('does not match a substring of the owner name', () => {
    withConfig({ owner: { name: 'Ada Lovelace' } })
    expect(targetIsOwner('Ada')).toBe(false)
  })

  it('returns false for blank input', () => {
    withConfig({ owner: { name: 'Ada' } })
    expect(targetIsOwner('   ')).toBe(false)
  })

  it('returns false when no owner is configured', () => {
    withConfig({})
    expect(targetIsOwner('anyone')).toBe(false)
  })
})

describe('buildOwnerClause', () => {
  it('returns an empty string when no owner identity is set', () => {
    withConfig({})
    expect(buildOwnerClause()).toBe('')
  })

  it('names the owner and lists their per-surface handles', () => {
    withConfig({ owner: { name: 'Ada', handles: { github: 'ada', slack: 'ada.l' } } })
    const clause = buildOwnerClause()
    expect(clause).toContain('Ada')
    expect(clause).toContain('github: ada')
    expect(clause).toContain('slack: ada.l')
  })

  it('falls back to a generic phrase when only handles are set, no name', () => {
    withConfig({ owner: { handles: { github: 'ada' } } })
    expect(buildOwnerClause()).toContain('the user you assist')
  })
})

describe('buildDirectivesClause', () => {
  it('returns an empty string when there are no hard memories', () => {
    vi.mocked(db.dbGetActiveHardMemories).mockReturnValue([])
    expect(buildDirectivesClause()).toBe('')
  })

  it('renders each hard memory as a bulleted standing rule', () => {
    vi.mocked(db.dbGetActiveHardMemories).mockReturnValue([
      { content: 'Never post to #general' } as any,
      { content: 'Always cc the tech lead' } as any
    ])
    const clause = buildDirectivesClause()
    expect(clause).toContain('- Never post to #general')
    expect(clause).toContain('- Always cc the tech lead')
  })

  it('returns an empty string when the DB lookup throws', () => {
    vi.mocked(db.dbGetActiveHardMemories).mockImplementation(() => {
      throw new Error('db not ready')
    })
    expect(buildDirectivesClause()).toBe('')
  })
})
