import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { readConfig, updateConfig } from './config'
import type { RepoLink, Signal } from '@shared/types'

const execFileAsync = promisify(execFile)

/**
 * Parses "owner/repo" from a GitHub URL in either html_url or api.github.com form.
 * Mirrors parseGithubOwnerRepo in memory-graph.ts — kept as a separate copy here
 * since repos.ts must not depend on the graph layer (config-only service).
 */
function parseGithubOwnerRepo(url: string): string | null {
  if (!url) return null
  const htmlMatch = url.match(/github\.com\/([^/]+)\/([^/?#]+)/)
  if (htmlMatch) return `${htmlMatch[1]}/${htmlMatch[2]}`
  const apiMatch = url.match(/api\.github\.com\/repos\/([^/]+)\/([^/?#]+)/)
  if (apiMatch) return `${apiMatch[1]}/${apiMatch[2]}`
  return null
}

export function getAllRepoLinks(): RepoLink[] {
  return readConfig().repos ?? []
}

export function getRepoLink(id: string): RepoLink | undefined {
  return getAllRepoLinks().find((r) => r.id === id)
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, timeout: 15_000 })
  return stdout.trim()
}

/**
 * Registers a local git checkout as a repo link. Reads the origin remote and current
 * default branch to prefill githubRepo/defaultBaseBranch — never clones or modifies
 * the checkout. Throws if localPath is not a git repository.
 */
export async function addRepoLink(localPath: string, jiraProjectKeys: string[]): Promise<RepoLink> {
  if (!existsSync(join(localPath, '.git'))) {
    throw new Error(`${localPath} does not look like a git repository (no .git directory)`)
  }

  let githubRepo: string | undefined
  try {
    const originUrl = await runGit(localPath, ['remote', 'get-url', 'origin'])
    githubRepo = parseGithubOwnerRepo(originUrl) ?? undefined
  } catch {
    // No origin remote configured — githubRepo stays undefined; the user can set it later.
  }

  let defaultBaseBranch = 'main'
  try {
    // origin/HEAD points at the remote's default branch, e.g. "origin/main"
    const ref = await runGit(localPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
    defaultBaseBranch = ref.replace(/^origin\//, '') || defaultBaseBranch
  } catch {
    try {
      defaultBaseBranch = await runGit(localPath, ['branch', '--show-current']) || defaultBaseBranch
    } catch {
      // Fall back to 'main' — the user can correct it in Settings.
    }
  }

  const link: RepoLink = {
    id: randomUUID(),
    localPath,
    githubRepo,
    jiraProjectKeys: jiraProjectKeys.map((k) => k.trim().toUpperCase()).filter(Boolean),
    defaultBaseBranch,
    authoringEnabled: true,
    created_at: new Date().toISOString()
  }

  const current = getAllRepoLinks()
  updateConfig({ repos: [...current, link] })
  return link
}

export function updateRepoLink(id: string, patch: Partial<Omit<RepoLink, 'id' | 'created_at'>>): RepoLink {
  const current = getAllRepoLinks()
  const idx = current.findIndex((r) => r.id === id)
  if (idx === -1) throw new Error(`Repo link ${id} not found`)
  const updated: RepoLink = { ...current[idx], ...patch }
  const next = [...current]
  next[idx] = updated
  updateConfig({ repos: next })
  return updated
}

export function removeRepoLink(id: string): void {
  const current = getAllRepoLinks()
  updateConfig({ repos: current.filter((r) => r.id !== id) })
}

/** Shared match logic behind resolveRepoForSignal and resolveRepoForNode. */
function matchRepoLink(
  surface: string,
  externalId: string,
  url: string,
  raw: Record<string, unknown>
): RepoLink | undefined {
  const links = getAllRepoLinks().filter((r) => r.authoringEnabled)
  if (links.length === 0) return undefined

  if (surface === 'github') {
    const ownerRepo =
      parseGithubOwnerRepo(url) ??
      parseGithubOwnerRepo(String(raw.repository_url ?? '')) ??
      ((raw.repository as Record<string, unknown> | undefined)?.full_name as string | undefined) ??
      (raw.repo as string | undefined) ??
      null
    if (!ownerRepo) return undefined
    return links.find((r) => r.githubRepo?.toLowerCase() === ownerRepo.toLowerCase())
  }

  if (surface === 'jira') {
    const key = externalId.split('-')[0]
    if (!key) return undefined
    return links.find((r) => r.jiraProjectKeys.some((k) => k.toLowerCase() === key.toLowerCase()))
  }

  return undefined
}

/**
 * Matches a signal's container (GitHub repo or Jira project) to a registered RepoLink.
 * Reuses the same owner/repo and jira-project-key parsing as deriveContainer in
 * memory-graph.ts. Returns undefined when no linked repo has authoring enabled for
 * this signal's container.
 */
export function resolveRepoForSignal(signal: Signal): RepoLink | undefined {
  return matchRepoLink(signal.surface, signal.external_id, signal.url, (signal.raw ?? {}) as Record<string, unknown>)
}

/**
 * Matches a graph node's key (`surface:kind:external_id`, e.g. "github:pull_request:482"
 * or "jira:issue:PROJ-123" — see memory-graph.ts ingestSignalIntoGraph) to a registered
 * RepoLink, without needing the underlying Signal row. Used by deep inference, which
 * only has focus nodes from the context packet at hand.
 */
export function resolveRepoForNode(key: string, url?: string): RepoLink | undefined {
  const parts = key.split(':')
  if (parts.length < 3) return undefined
  const [surface, , externalId] = parts
  return matchRepoLink(surface, externalId, url ?? '', {})
}
