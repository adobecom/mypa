/**
 * Scope enforcement — deterministic filter for the ambient pipeline.
 *
 * When the user has configured allowed containers for a surface (derived
 * automatically from check-in conversations), any intent whose focus nodes
 * trace back to an out-of-scope container is dropped before it ever reaches
 * the DB, graph, or UI.
 *
 * The filter is conservative by design:
 *   - If no scope is configured for a surface, nothing is blocked.
 *   - If focus nodes have no container edges (e.g. repo info was missing),
 *     the intent is ALLOWED through — we can't prove it's out of scope.
 *   - If the surface has no registered ScopeSurfaceSpec, nothing is blocked.
 *   - Comparison is always case-insensitive.
 *
 * Scope identifiers are stored in ScopeConfig.allowed keyed by surface string,
 * and are populated by check-in extraction (checkin.ts) — not by manual input.
 */

import { readConfig } from './config'
import { dbGetEdgesFrom, dbGetNodeById } from '../db/index'
import { scopeSurfaceFor } from '@shared/scope-surfaces'
import type { IntentObject, GraphNode } from '@shared/types'

/**
 * Returns true if the intent should be DROPPED because all its resolvable
 * containers are outside the configured scope.
 *
 * Returns false (let it through) when:
 *   - No scope config is set for the relevant surface.
 *   - The surface is not in the SCOPE_SURFACES registry.
 *   - The intent has no focus nodes (time digest, etc.).
 *   - None of the focus nodes have container edges (container info unavailable).
 *   - At least one container IS on the allowlist.
 *
 * @param obj         The inferred IntentObject.
 * @param focusNodes  The graph nodes in scope for this intent.
 */
export function violatesScope(obj: IntentObject, focusNodes: GraphNode[]): boolean {
  const scope = readConfig().scope
  if (!scope) return false

  const surface = obj.proposed_action.surface

  // Normalize: support the legacy allowedGithubOrgs / allowedJiraProjects / allowedSlackChannels
  // shape so any config written before the surface-keyed migration still works.
  const allowed = normalizeScopeAllowed(scope)

  const allowList = allowed[surface]

  // No restriction configured for this surface — always pass.
  if (!allowList || allowList.length === 0) return false

  // No spec registered for this surface — don't block.
  const spec = scopeSurfaceFor(surface)
  if (!spec) return false

  const normalizedList = allowList.map((s) => s.toLowerCase())

  if (focusNodes.length === 0) return false

  // For each focus node, find its container(s) via part_of edges.
  // We gather every resolvable container key across all focus nodes.
  const resolvedContainerKeys: string[] = []

  for (const node of focusNodes) {
    const edges = dbGetEdgesFrom(node.id).filter((e) => e.rel === 'part_of')
    for (const edge of edges) {
      const container = dbGetNodeById(edge.dst_id)
      if (container) {
        resolvedContainerKeys.push(container.key.toLowerCase())
      }
    }
  }

  // Conservative: if we found no container edges, we can't determine scope
  // → let the intent through rather than silently dropping it.
  if (resolvedContainerKeys.length === 0) return false

  // Use the registry spec to extract a comparable identifier from each container key.
  const isAllowed = resolvedContainerKeys.some((key) => {
    const identifier = spec.parseIdentifier(key).toLowerCase()
    return identifier !== '' && normalizedList.includes(identifier)
  })

  return !isAllowed
}

/**
 * Normalizes a ScopeConfig to the surface-keyed `allowed` map shape, folding in
 * any legacy per-surface named fields written by earlier app versions.
 */
function normalizeScopeAllowed(scope: { allowed?: Record<string, string[]> }): Record<string, string[]> {
  // In the current schema scope only has `allowed`. Cast to `any` to safely
  // read any legacy fields that may still be present in a user's config.json.
  const legacy = scope as any
  const base: Record<string, string[]> = { ...(scope.allowed ?? {}) }

  if (Array.isArray(legacy.allowedGithubOrgs) && legacy.allowedGithubOrgs.length > 0) {
    base.github = [...new Set([...(base.github ?? []), ...legacy.allowedGithubOrgs])]
  }
  if (Array.isArray(legacy.allowedJiraProjects) && legacy.allowedJiraProjects.length > 0) {
    base.jira = [...new Set([...(base.jira ?? []), ...legacy.allowedJiraProjects])]
  }
  if (Array.isArray(legacy.allowedSlackChannels) && legacy.allowedSlackChannels.length > 0) {
    base.slack = [...new Set([...(base.slack ?? []), ...legacy.allowedSlackChannels])]
  }

  return base
}
