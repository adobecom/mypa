import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, readdirSync, realpathSync, type Dirent } from 'fs'
import { join, parse as parsePath } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'crypto'
import { readConfig, updateConfig } from './config'
import type { RepoLink, Signal } from '@shared/types'

const execFileAsync = promisify(execFile)

// ─── Local repo discovery ─────────────────────────────────────────────────────
//
// mypa scans user-chosen parent folders ("code roots") for git checkouts instead
// of requiring each repo to be added by hand. Discovery never clones or writes to
// a checkout — it only reads `.git` presence and origin/branch metadata, same as
// the legacy manual-add path below.

/** Directory names never descended into while scanning for repos. */
const SCAN_IGNORE_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'target', 'vendor', 'Pods', 'Library', '.Trash'
])

/** How many directory levels below a code root to search for a `.git` checkout. */
const SCAN_MAX_DEPTH = 4
/** Safety caps so a pathological tree (or a root picked too high, e.g. home dir) can't hang the scan. */
const SCAN_MAX_REPOS = 500
const SCAN_MAX_DIRS_VISITED = 20_000

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

/** Reads a checkout's origin remote and default branch — never clones or modifies anything. */
async function deriveRepoMetadata(localPath: string): Promise<{ githubRepo?: string; defaultBaseBranch: string }> {
  let githubRepo: string | undefined
  try {
    const originUrl = await runGit(localPath, ['remote', 'get-url', 'origin'])
    githubRepo = parseGithubOwnerRepo(originUrl) ?? undefined
  } catch {
    // No origin remote configured — githubRepo stays undefined.
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

  return { githubRepo, defaultBaseBranch }
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

// ─── Code roots ───────────────────────────────────────────────────────────────

export function getCodeRoots(): string[] {
  return readConfig().codeRoots ?? []
}

/** Normalizes, resolves symlinks, and dedups a list of code-root paths, then persists it. */
export function setCodeRoots(paths: string[]): string[] {
  const normalized = normalizeRoots(paths)
  updateConfig({ codeRoots: normalized })
  return normalized
}

export function addCodeRoots(paths: string[]): string[] {
  for (const p of paths) {
    if (isDangerousRoot(p)) {
      throw new Error(`"${p}" is too broad to scan — pick a more specific folder (e.g. the one containing your repos), not your whole home directory or a system folder.`)
    }
  }
  return setCodeRoots([...getCodeRoots(), ...paths])
}

export function removeCodeRoot(path: string): string[] {
  const target = safeRealpath(path)
  return setCodeRoots(getCodeRoots().filter((r) => safeRealpath(r) !== target))
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * Rejects filesystem/drive roots, and the user's home directory itself, as scan
 * roots. Without this a fat-fingered folder-picker selection (or a directly
 * IPC-invoked addCodeRoots call) turns into a large, repeating, main-thread-
 * blocking disk crawl on every future startup rather than a contained failure.
 */
function isDangerousRoot(path: string): boolean {
  const real = safeRealpath(path)
  if (real === homedir()) return true
  return parsePath(real).root === real
}

function normalizeRoots(paths: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const p of paths) {
    const resolved = safeRealpath(p)
    if (seen.has(resolved)) continue
    seen.add(resolved)
    result.push(resolved)
  }
  return result
}

// ─── Scanning ─────────────────────────────────────────────────────────────────

const MYPA_HOME = safeRealpath(join(homedir(), '.mypa'))

/** How many directories to visit between yields back to the event loop during a scan. */
const SCAN_YIELD_EVERY = 200

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * Walks `root` looking for git checkouts (a directory containing `.git`), never
 * descending into a repo it already found (avoids submodules / nested worktrees)
 * or into `SCAN_IGNORE_DIRS` / dotfolders / symlinked directories / mypa's own
 * `~/.mypa` tree. Returns realpath-resolved, deduplicated repo paths. Yields back
 * to the event loop periodically so a large root doesn't freeze the whole app —
 * Electron's main process is single-threaded and this walk is otherwise all
 * synchronous fs calls.
 */
async function findGitRepos(root: string): Promise<string[]> {
  const found = new Set<string>()
  let dirsVisited = 0

  const rootReal = safeRealpath(root)
  if (rootReal === MYPA_HOME || rootReal.startsWith(MYPA_HOME + '/')) return []
  if (!existsSync(rootReal)) return []

  const stack: Array<{ dir: string; depth: number }> = [{ dir: rootReal, depth: 0 }]

  while (stack.length > 0) {
    if (found.size >= SCAN_MAX_REPOS || dirsVisited >= SCAN_MAX_DIRS_VISITED) break
    const { dir, depth } = stack.pop()!
    dirsVisited++
    if (dirsVisited % SCAN_YIELD_EVERY === 0) await yieldToEventLoop()

    if (existsSync(join(dir, '.git'))) {
      found.add(dir)
      continue // never descend into a repo we already found
    }
    if (depth >= SCAN_MAX_DEPTH) continue

    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue // permission denied, disappeared mid-scan, etc.
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      if (entry.name.startsWith('.') || SCAN_IGNORE_DIRS.has(entry.name)) continue
      const childPath = join(dir, entry.name)
      if (childPath === MYPA_HOME) continue
      stack.push({ dir: childPath, depth: depth + 1 })
    }
  }

  return [...found]
}

/**
 * When a GitHub org allowlist is configured (see ScopeConfig / seedScopeIfUnset),
 * only repos in an allowed org are auto-registered — mirrors the "Adobe scope
 * only" filtering already applied to ingested signals. No allowlist means no
 * restriction, matching the conservative default used elsewhere in scope.ts.
 */
function repoOrgInScope(githubRepo: string | undefined): boolean {
  const allowedOrgs = readConfig().scope?.allowed?.github ?? []
  if (allowedOrgs.length === 0) return true
  if (!githubRepo) return false // org unverifiable without a GitHub remote
  const org = githubRepo.split('/')[0]?.toLowerCase()
  return allowedOrgs.some((o) => o.toLowerCase() === org)
}

let rescanInFlight: Promise<RepoLink[]> | null = null
let rescanQueued: Promise<RepoLink[]> | null = null

/**
 * Re-scans all configured code roots and reconciles the results into config.repos:
 *  - existing discovered repos still on disk (and still in scope) are refreshed
 *    but keep their id/created_at/authoringEnabled/jiraProjectKeys,
 *  - newly found repos are added with authoringEnabled: false,
 *  - previously-discovered repos no longer found (deleted, moved, or now out of
 *    scope) are dropped.
 * Manual (source !== 'discovered') repos are never touched. Runs are serialized
 * so a startup scan and a user-triggered rescan can't race each other's config
 * write. A call that arrives while a scan is already running doesn't just await
 * that in-progress scan — it queues (at most) one follow-up scan afterward, so a
 * caller that just wrote new code roots (e.g. addCodeRoots) always gets back a
 * scan that reflects its own write, not a stale one that started before it.
 */
export function rescanRepos(): Promise<RepoLink[]> {
  if (rescanInFlight) {
    if (!rescanQueued) {
      rescanQueued = rescanInFlight.then(() => {
        rescanQueued = null
        return runRescan()
      })
    }
    return rescanQueued
  }
  return runRescan()
}

function runRescan(): Promise<RepoLink[]> {
  rescanInFlight = doRescan().finally(() => {
    rescanInFlight = null
  })
  return rescanInFlight
}

async function doRescan(): Promise<RepoLink[]> {
  const roots = getCodeRoots()
  const foundPaths = new Set<string>()
  for (const root of roots) {
    for (const path of await findGitRepos(root)) foundPaths.add(path)
  }

  const foundMeta = new Map<string, { githubRepo?: string; defaultBaseBranch: string }>()
  for (const path of foundPaths) {
    const meta = await deriveRepoMetadata(path)
    if (repoOrgInScope(meta.githubRepo)) foundMeta.set(path, meta)
  }

  // Read config fresh right before the single write below, to shrink the window
  // in which a concurrent Settings edit (e.g. a jiraProjectKeys change) could race.
  const existing = getAllRepoLinks()
  const manual = existing.filter((r) => r.source !== 'discovered')
  // Realpath-normalized so a manual link added before auto-discovery (which may not
  // have been realpath'd) still matches the same, already-realpath'd, scanned path.
  const manualPaths = new Set(manual.map((r) => safeRealpath(r.localPath)))
  const existingDiscovered = new Map(existing.filter((r) => r.source === 'discovered').map((r) => [r.localPath, r]))

  const now = new Date().toISOString()
  const nextDiscovered: RepoLink[] = []
  for (const [path, meta] of foundMeta) {
    if (manualPaths.has(path)) continue // already tracked as a manual link — don't create a duplicate

    const prior = existingDiscovered.get(path)
    if (prior) {
      nextDiscovered.push({ ...prior, githubRepo: meta.githubRepo, defaultBaseBranch: meta.defaultBaseBranch, lastSeenAt: now })
    } else {
      nextDiscovered.push({
        id: randomUUID(),
        localPath: path,
        githubRepo: meta.githubRepo,
        jiraProjectKeys: [],
        defaultBaseBranch: meta.defaultBaseBranch,
        authoringEnabled: false,
        source: 'discovered',
        created_at: now,
        lastSeenAt: now
      })
    }
  }

  updateConfig({ repos: [...manual, ...nextDiscovered] })
  return nextDiscovered
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
