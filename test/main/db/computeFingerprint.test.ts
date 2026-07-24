import { describe, it, expect } from 'vitest'
import { computeFingerprint } from '@main/db/index'

// Pure crypto hash — the electron mock in test/setup.ts covers db/index.ts's
// top-level `import { app } from 'electron'` (app.getPath is only called inside
// initDb(), which this test never invokes).

describe('computeFingerprint', () => {
  it('is deterministic for the same inputs', () => {
    const a = computeFingerprint('github', '482', { title: 'x', body: 'y' })
    const b = computeFingerprint('github', '482', { title: 'x', body: 'y' })
    expect(a).toBe(b)
  })

  it('changes when any input changes', () => {
    const base = computeFingerprint('github', '482', { title: 'x' })
    expect(computeFingerprint('jira', '482', { title: 'x' })).not.toBe(base)
    expect(computeFingerprint('github', '999', { title: 'x' })).not.toBe(base)
    expect(computeFingerprint('github', '482', { title: 'y' })).not.toBe(base)
  })

  it('returns a 16-character hex string', () => {
    const fp = computeFingerprint('slack', 'C123:456', { text: 'hi' })
    expect(fp).toMatch(/^[0-9a-f]{16}$/)
  })
})
