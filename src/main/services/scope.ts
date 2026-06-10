/**
 * Scope enforcement — deterministic filter for the ambient pipeline.
 *
 * When the user has configured allowed containers (GitHub orgs, Jira projects,
 * Slack channels), any intent whose focus nodes trace back to an out-of-scope
 * container is dropped before it ever reaches the DB, graph, or UI.
 *
 * The filter is conservative by design:
 *   - If no scope is configured for a surface, nothing is blocked.
 *   - If focus nodes have no container edges (e.g. repo info was missing),
 *     the intent is ALLOWED through — we can't prove it's out of scope.
 *   - Comparison is always case-insensitive.
 */

import { readConfig } from './config'
import { dbGetEdgesFrom, dbGetNodeById } from '../db/index'
import type { IntentObject, GraphNode } from '@shared/types'

/**
 * Returns true if the intent should be DROPPED because all its resolvable
 * containers are outside the configured scope.
 *
 * Returns false (let it through) when:
 *   - No scope config is set for the relevant surface.
 *   - The intent has no focus nodes (time digest, etc.).
 *   - None of the focus nodes have container edges (container info unavailable).
 *   - At least one container IS on the allowlist.
 *
 * @param obj         The inferred IntentObject.
 * @param focusNodes  The graph nodes in scope for this intent. Pass
 *                    ContextPacket.focusNodes from the ambient cycle, or look
 *                    up nodes by ID when only IDs are available.
 */
export function violatesScope(obj: IntentObject, focusNodes: GraphNode[]): boolean {
  const scope = readConfig().scope
  if (!scope) return false

  const surface = obj.proposed_action.surface

  // Pick the relevant allowlist for this surface.
  let allowList: string[] | undefined
  if (surface === 'github') allowList = scope.allowedGithubOrgs
  else if (surface === 'jira') allowList = scope.allowedJiraProjects
  else if (surface === 'slack') allowList = scope.allowedSlackChannels

  // No restriction configured for this surface — always pass.
  if (!allowList || allowList.length === 0) return false

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

  // Extract the scope identifier from the container key and check the allowlist.
  // Key formats:
  //   GitHub:  github:repo:<owner>/<repo>  → check <owner>
  //   Jira:    jira:project:<KEY>           → check <KEY>
  //   Slack:   slack:channel:<id>           → check <id>
  const isAllowed = resolvedContainerKeys.some((key) => {
    if (surface === 'github') {
      // key = "github:repo:owner/repo" → owner = key.split(':')[2]?.split('/')[0]
      const repoPath = key.split(':')[2] ?? ''
      const org = repoPath.split('/')[0] ?? ''
      return normalizedList.includes(org)
    }
    if (surface === 'jira') {
      // key = "jira:project:PROJ" → projectKey = key.split(':')[2]
      const projectKey = key.split(':')[2] ?? ''
      return normalizedList.includes(projectKey)
    }
    if (surface === 'slack') {
      // key = "slack:channel:<id>" → channelId = key.split(':')[2]
      const channelId = key.split(':')[2] ?? ''
      return normalizedList.includes(channelId)
    }
    return true // unknown surface — don't block
  })

  return !isAllowed
}
