/**
 * Registry of scope-capable surfaces — the integration surfaces that can
 * ingest ambient signals and therefore benefit from container-level filtering.
 *
 * This is the single place to register a new scope-capable surface.
 * Each entry describes how to detect the surface is enabled (via mcp_servers[].name),
 * how to label it in the UI, and how to extract a scope identifier from a container key.
 *
 * Container keys follow the pattern `<surface>:<type>:<identifier>` — e.g.
 * `github:repo:adobecom/milo` (identifier = the org, `adobecom`).
 */

import type { IntentSurface } from './types'

export interface ScopeSurfaceSpec {
  /** Must match IntentSurface — the surface field emitted on IntentObject. */
  surface: IntentSurface
  /**
   * The mcp_servers[].name that marks this integration as enabled.
   * Typically the same as surface; explicit here so the mapping is clear.
   */
  integrationId: string
  /** Human-readable label for the allowlist, e.g. 'GitHub orgs'. */
  label: string
  /** Singular noun for individual items, e.g. 'org', 'project', 'channel'. */
  itemNoun: string
  /**
   * Given a `part_of` container node's key string, return the scope identifier
   * to compare against the user's allowlist.
   * Returns '' when the key cannot be parsed — callers treat '' as no match.
   */
  parseIdentifier(containerKey: string): string
}

export const SCOPE_SURFACES: ScopeSurfaceSpec[] = [
  {
    surface: 'github',
    integrationId: 'github',
    label: 'GitHub orgs',
    itemNoun: 'org',
    // key = "github:repo:owner/repo" → owner
    parseIdentifier: (k) => (k.split(':')[2] ?? '').split('/')[0] ?? ''
  },
  {
    surface: 'jira',
    integrationId: 'jira',
    label: 'Jira projects',
    itemNoun: 'project',
    // key = "jira:project:KEY" → KEY
    parseIdentifier: (k) => k.split(':')[2] ?? ''
  },
  {
    surface: 'slack',
    integrationId: 'slack',
    label: 'Slack channels',
    itemNoun: 'channel',
    // key = "slack:channel:<id>" → id
    parseIdentifier: (k) => k.split(':')[2] ?? ''
  }
]

/** Look up the spec for a given surface string. Returns undefined for unknown surfaces. */
export const scopeSurfaceFor = (surface: string): ScopeSurfaceSpec | undefined =>
  SCOPE_SURFACES.find((x) => x.surface === surface)
