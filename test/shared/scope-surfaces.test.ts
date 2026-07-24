import { describe, it, expect } from 'vitest'
import { SCOPE_SURFACES, scopeSurfaceFor } from '@shared/scope-surfaces'

describe('scopeSurfaceFor', () => {
  it('finds the spec for a known surface', () => {
    expect(scopeSurfaceFor('github')?.label).toBe('GitHub orgs')
    expect(scopeSurfaceFor('jira')?.itemNoun).toBe('project')
    expect(scopeSurfaceFor('slack')?.itemNoun).toBe('channel')
  })

  it('returns undefined for an unknown surface', () => {
    expect(scopeSurfaceFor('notion')).toBeUndefined()
    expect(scopeSurfaceFor('')).toBeUndefined()
  })
})

describe('parseIdentifier per surface', () => {
  it('github: extracts the org from "github:repo:owner/repo"', () => {
    const spec = scopeSurfaceFor('github')!
    expect(spec.parseIdentifier('github:repo:adobecom/milo')).toBe('adobecom')
  })

  it('github: returns empty string when the container key is malformed', () => {
    const spec = scopeSurfaceFor('github')!
    expect(spec.parseIdentifier('github:repo:')).toBe('')
    expect(spec.parseIdentifier('not-a-key')).toBe('')
  })

  it('jira: extracts the project key from "jira:project:KEY"', () => {
    const spec = scopeSurfaceFor('jira')!
    expect(spec.parseIdentifier('jira:project:PROJ')).toBe('PROJ')
  })

  it('slack: extracts the channel id from "slack:channel:<id>"', () => {
    const spec = scopeSurfaceFor('slack')!
    expect(spec.parseIdentifier('slack:channel:C123456')).toBe('C123456')
  })

  it('every registered surface has a non-empty label and itemNoun', () => {
    for (const spec of SCOPE_SURFACES) {
      expect(spec.label.length).toBeGreaterThan(0)
      expect(spec.itemNoun.length).toBeGreaterThan(0)
    }
  })
})
