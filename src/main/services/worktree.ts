import { execFile } from 'child_process'
import { promisify } from 'util'
import { mkdirSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { RepoLink } from '@shared/types'

const execFileAsync = promisify(execFile)

const WORKTREES_ROOT = join(homedir(), '.mypa', 'worktrees')

/** Reduces a free-form task identifier (e.g. a Jira key or intent id) to a safe
 *  path/branch-name component — lowercase alnum and dashes only. */
function slugify(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'task'
}

function repoSlug(repoLink: RepoLink): string {
  return slugify(repoLink.githubRepo ?? repoLink.localPath.split('/').filter(Boolean).pop() ?? 'repo')
}

async function runGit(cwd: string, args: string[], timeout = 60_000): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, timeout })
    return stdout.trim()
  } catch (err) {
    const e = err as Error & { stderr?: string }
    throw new Error(`git ${args.join(' ')} failed: ${e.stderr ?? e.message}`)
  }
}

export interface WorktreeHandle {
  worktreePath: string
  branch: string
  baseBranch: string
}

/**
 * Creates an isolated git worktree + fresh branch off the repo's default base
 * branch, at ~/.mypa/worktrees/<repo>/<taskKey>/. The user's real checkout
 * (repoLink.localPath) is only ever read from (fetch) — never checked out to,
 * so its working tree and index are untouched.
 */
export async function createWorktree(repoLink: RepoLink, taskKey: string): Promise<WorktreeHandle> {
  const slug = slugify(taskKey)
  const branch = `mypa/${slug}`
  const worktreePath = join(WORKTREES_ROOT, repoSlug(repoLink), slug)

  if (existsSync(worktreePath)) {
    throw new Error(`A worktree already exists at ${worktreePath} — discard the existing work product first`)
  }
  mkdirSync(join(WORKTREES_ROOT, repoSlug(repoLink)), { recursive: true })

  const baseBranch = repoLink.defaultBaseBranch || 'main'
  // Fetch only the base branch — cheap, and keeps the new branch current with upstream
  // without touching anything else in the user's checkout.
  await runGit(repoLink.localPath, ['fetch', 'origin', baseBranch])

  const startPoint = `origin/${baseBranch}`
  try {
    await runGit(repoLink.localPath, ['worktree', 'add', '-b', branch, worktreePath, startPoint])
  } catch (err) {
    // Branch name collision from a previous abandoned attempt — surface a clear error
    // rather than a raw git message about the ref already existing.
    throw new Error(`Could not create worktree/branch "${branch}": ${(err as Error).message}`)
  }

  return { worktreePath, branch, baseBranch }
}

export interface DiffResult {
  diffStat: string
  filesChanged: string[]
  diff: string
}

/**
 * Stages all changes in the worktree (safe — the worktree is disposable and isolated
 * from the user's checkout) and returns the staged diff for review. Does not commit;
 * commitAndPush() commits at ship time once the user has approved.
 */
export async function captureDiff(worktreePath: string): Promise<DiffResult> {
  await runGit(worktreePath, ['add', '-A'])
  const diffStat = await runGit(worktreePath, ['diff', '--cached', '--stat'])
  const nameOnly = await runGit(worktreePath, ['diff', '--cached', '--name-only'])
  const diff = await runGit(worktreePath, ['diff', '--cached'], 30_000)
  const filesChanged = nameOnly.split('\n').map((l) => l.trim()).filter(Boolean)
  return { diffStat, filesChanged, diff }
}

/** Commits the currently staged changes and pushes the branch to origin. */
export async function commitAndPush(worktreePath: string, branch: string, message: string): Promise<void> {
  // Re-stage in case the diff was reviewed a while ago and nothing else changed —
  // a no-op if the previous captureDiff() staging is still current.
  await runGit(worktreePath, ['add', '-A'])
  await runGit(worktreePath, ['commit', '-m', message])
  await runGit(worktreePath, ['push', '-u', 'origin', branch])
}

/**
 * Removes the worktree and, when abandon=true, deletes the local branch too.
 * Safe to call even if the worktree was already manually removed.
 */
export async function pruneWorktree(repoLocalPath: string, worktreePath: string, branch: string, abandon: boolean): Promise<void> {
  try {
    await runGit(repoLocalPath, ['worktree', 'remove', worktreePath, '--force'])
  } catch {
    // Worktree metadata may already be gone (e.g. directory deleted out of band) —
    // prune stale entries and fall through to filesystem cleanup below.
    await runGit(repoLocalPath, ['worktree', 'prune']).catch(() => {})
  }
  if (existsSync(worktreePath)) {
    rmSync(worktreePath, { recursive: true, force: true })
  }
  if (abandon) {
    await runGit(repoLocalPath, ['branch', '-D', branch]).catch(() => {
      // Branch may not have been created yet (authoring failed before first commit) — ignore.
    })
  }
}
