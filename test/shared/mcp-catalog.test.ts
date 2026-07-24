import { describe, it, expect } from 'vitest'
import { MCP_CATALOG, CATALOG_CATEGORIES } from '@shared/mcp-catalog'

describe('MCP_CATALOG data invariants', () => {
  it('is non-empty', () => {
    expect(MCP_CATALOG.length).toBeGreaterThan(0)
  })

  it('has unique ids', () => {
    const ids = MCP_CATALOG.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every entry uses a category from CATALOG_CATEGORIES', () => {
    for (const entry of MCP_CATALOG) {
      expect(CATALOG_CATEGORIES).toContain(entry.category)
    }
  })

  it('every entry has a non-empty command and name', () => {
    for (const entry of MCP_CATALOG) {
      expect(entry.command.length).toBeGreaterThan(0)
      expect(entry.name.length).toBeGreaterThan(0)
    }
  })

  it('oauth entries declare an oauthProvider', () => {
    for (const entry of MCP_CATALOG) {
      if (entry.authType === 'oauth') {
        expect(entry.oauthProvider).toBeDefined()
      }
    }
  })
})
