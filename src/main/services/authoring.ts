import type { Intent, WorkProduct } from '@shared/types'
import { getRepoLink } from './repos'
import { createWorktree, captureDiff, commitAndPush, pruneWorktree } from './worktree'
import { runAuthoringAgent } from './agent'
import { getToolInputSchema, callTool } from './mcp'
import { recordApproval, recordExecution } from './autonomy'
import { ambientDismissIntent } from './ambient'
import {
  dbGetIntent,
  dbUpdateIntentStatus,
  dbCreateWorkProduct,
  dbGetWorkProductByIntent,
  dbUpdateWorkProduct,
  dbAppendActionLog
} from '../db/index'
import { broadcast } from '../windows'

/** Action-type key convention shared with autonomy.ts/ambient.ts — `${surface}:${verb}`. */
function actionTypeFor(intent: Intent): string {
  return `${intent.surface}:${intent.verb}`
}

// Intent ids with an authoring run currently in flight in this process. Guards
// discardWorkProduct against pruning a worktree a live runAuthoringAgent call is
// still reading/writing — a restart clears this (in-memory only), which is fine:
// after a restart there is no in-flight process left to race with.
const inFlightAuthoring = new Set<string>()

/**
 * Payload shape for an `author_fix` intent (verb === 'author_fix'). Set by
 * inference.ts when it proposes attempting a code fix. The `_`-prefixed routing
 * fields follow the same convention buildToolArgs uses in ambient.ts, and —
 * critically — are derived ONLY from the trusted triggering signal in
 * inference.ts (deriveTrustedTicketRouting), never from the model's own JSON
 * output. There is deliberately no model-chosen notification destination (e.g.
 * an arbitrary Slack channel or reviewer list) here: unlike a ticket comment,
 * which has a trusted anchor (the item that triggered the run), a "which
 * channel should be notified" choice has no equivalent trusted source and
 * would let content the model read from an external ticket/PR pick where a
 * real notification gets sent.
 */
export interface AuthorFixPayload {
  repo_id: string
  /** Plain-language description of what to fix/build, handed to the authoring agent. */
  task_description: string
  // Ticket to comment on once shipped — at most one of the jira/github pairs is set,
  // matching whichever surface the triggering signal came from.
  _issue_key?: string
  _owner?: string
  _repo?: string
  _issue_number?: number
}

function getPayload(intent: Intent): AuthorFixPayload {
  return intent.payload as unknown as AuthorFixPayload
}

function broadcastWorkProduct(wp: WorkProduct): void {
  broadcast('ambient:work-product-updated', wp)
}

/**
 * Starts (or resumes watching) the code-authoring run for an approved author_fix
 * intent: creates an isolated worktree, runs the authoring agent, and captures the
 * resulting diff as a work product for review. Idempotent — calling again for an
 * intent that already has a work product returns the existing one without
 * re-running authoring.
 */
export async function startAuthoring(intentId: string): Promise<WorkProduct> {
  const intent = dbGetIntent(intentId)
  if (!intent) throw new Error(`Intent ${intentId} not found`)
  if (intent.verb !== 'author_fix') throw new Error(`Intent ${intentId} is not an author_fix intent`)

  const existing = dbGetWorkProductByIntent(intentId)
  if (existing) return existing

  const payload = getPayload(intent)
  const repoLink = getRepoLink(payload.repo_id)
  if (!repoLink) throw new Error(`No repo linked with id ${payload.repo_id}`)
  if (!repoLink.authoringEnabled) throw new Error(`Authoring is disabled for ${repoLink.localPath}`)

  // Tapping "Start" is the user's approval to begin — mirrors the tier/approval
  // bookkeeping the normal approve flow does (see ambient.ts ambientApproveIntent),
  // so this action type earns trust the same way (autonomy.ts recordApproval /
  // CONSECUTIVE_APPROVALS_TO_LOWER) and shows up in the Activity log.
  const actionType = actionTypeFor(intent)
  dbUpdateIntentStatus(intentId, 'approved')
  recordApproval(actionType)
  dbAppendActionLog({
    intent_id: intentId,
    event: 'approved',
    action_type: actionType,
    tier: intent.tier,
    detail: {},
    created_at: new Date().toISOString()
  })

  inFlightAuthoring.add(intentId)
  try {
    const { worktreePath, branch, baseBranch } = await createWorktree(repoLink, intentId)
    let wp = dbCreateWorkProduct(intentId, repoLink.id, worktreePath, branch, baseBranch)
    broadcastWorkProduct(wp)

    const result = await runAuthoringAgent(worktreePath, payload.task_description, (status) => {
      console.log(`[authoring] ${intentId}: ${status}`)
    })

    if (!result.ok) {
      const errorMsg = result.error ?? 'Authoring failed'
      wp = dbUpdateWorkProduct(wp.id, { status: 'failed', error: errorMsg, summary: '', diff_stat: '', files_changed: [], diff: '', pr_url: null, shipped_at: null })!
      dbUpdateIntentStatus(intentId, 'failed', errorMsg)
      dbAppendActionLog({
        intent_id: intentId, event: 'failed', action_type: actionType, tier: intent.tier,
        detail: { error: errorMsg }, created_at: new Date().toISOString()
      })
      broadcastWorkProduct(wp)
      return wp
    }

    const { diffStat, filesChanged, diff } = await captureDiff(worktreePath)
    if (filesChanged.length === 0) {
      const errorMsg = 'The authoring agent finished without making any file changes.'
      wp = dbUpdateWorkProduct(wp.id, {
        status: 'failed', error: errorMsg, summary: result.text.trim(),
        diff_stat: diffStat, files_changed: filesChanged, diff, pr_url: null, shipped_at: null
      })!
      dbUpdateIntentStatus(intentId, 'failed', 'No changes produced')
      dbAppendActionLog({
        intent_id: intentId, event: 'failed', action_type: actionType, tier: intent.tier,
        detail: { error: errorMsg }, created_at: new Date().toISOString()
      })
      broadcastWorkProduct(wp)
      return wp
    }

    const summary = result.text.trim() || `Changes to address: ${payload.task_description}`.slice(0, 500)
    wp = dbUpdateWorkProduct(wp.id, {
      status: 'ready', summary, diff_stat: diffStat, files_changed: filesChanged, diff,
      error: null, pr_url: null, shipped_at: null
    })!
    broadcastWorkProduct(wp)
    return wp
  } finally {
    inFlightAuthoring.delete(intentId)
  }
}

export function getWorkProductForIntent(intentId: string): WorkProduct | null {
  return dbGetWorkProductByIntent(intentId)
}

/** Best-effort extraction of a PR URL from a create_pull_request tool result. */
function extractPrUrl(toolResultText: string): string | null {
  try {
    const parsed = JSON.parse(toolResultText)
    const url = parsed?.html_url ?? parsed?.url ?? parsed?.pr_url
    if (typeof url === 'string' && url) return url
  } catch {
    // Not JSON — fall through to a plain URL scan below.
  }
  const match = toolResultText.match(/https:\/\/github\.com\/\S+\/pull\/\d+/)
  return match ? match[0] : null
}

/**
 * Ships a ready work product: pushes the branch, opens the PR, comments on the
 * originating ticket with the PR link, and notifies Slack if a channel is known.
 * Validates that everything needed for the planned steps is present before making
 * any external call; once underway, a failing step is recorded on the work product
 * (with whatever completed successfully, e.g. a pr_url) rather than silently lost.
 */
export async function shipWorkProduct(intentId: string): Promise<Intent> {
  const intent = dbGetIntent(intentId)
  if (!intent) throw new Error(`Intent ${intentId} not found`)
  const wp = dbGetWorkProductByIntent(intentId)
  if (!wp) throw new Error(`No work product for intent ${intentId}`)
  if (wp.status !== 'ready') throw new Error(`Work product is not ready to ship (status: ${wp.status})`)

  const repoLink = getRepoLink(wp.repo_id)
  if (!repoLink) throw new Error(`No repo linked with id ${wp.repo_id}`)
  if (!repoLink.githubRepo) throw new Error(`Repo link for ${repoLink.localPath} has no GitHub repo configured — cannot open a PR`)
  const [owner, repo] = repoLink.githubRepo.split('/')
  if (!owner || !repo) throw new Error(`Repo link githubRepo "${repoLink.githubRepo}" is not in "owner/repo" form`)

  const payload = getPayload(intent)
  const title = (intent.target || wp.summary.split('\n')[0] || `mypa: ${wp.branch}`).slice(0, 200)
  const prBody = wp.summary || 'Authored by mypa.'

  // Pre-flight: validate the PR-create call against the live tool schema before
  // touching git or any other external system — mirrors the all-or-nothing
  // pre-flight pattern executeActions() uses in ambient.ts.
  const prArgs: Record<string, unknown> = { owner, repo, title, body: prBody, head: wp.branch, base: wp.base_branch }
  const prSchema = getToolInputSchema('github', 'create_pull_request')
  if (prSchema) {
    const required = (prSchema.required as string[] | undefined) ?? []
    const missing = required.filter((k) => prArgs[k] === undefined || prArgs[k] === null)
    if (missing.length > 0) {
      throw new Error(`Cannot open PR — missing required fields: ${missing.join(', ')}`)
    }
  }

  broadcastWorkProduct(dbUpdateWorkProduct(wp.id, { status: 'shipping' })!)

  const actionType = actionTypeFor(intent)
  let pushed = false
  let prUrl: string | null = null
  try {
    await commitAndPush(wp.worktree_path, wp.branch, title)
    pushed = true

    const prResult = await callTool('github', 'create_pull_request', prArgs)
    prUrl = extractPrUrl(prResult)
    dbUpdateWorkProduct(wp.id, { pr_url: prUrl })

    const linkLine = prUrl ? `\n\nOpened: ${prUrl}` : ''

    if (payload._issue_key) {
      await callTool('jira', 'jira_add_comment', {
        issue_key: payload._issue_key,
        comment: `mypa opened a PR for this ticket.${linkLine}`,
        body: `mypa opened a PR for this ticket.${linkLine}`
      })
    } else if (payload._owner && payload._repo && payload._issue_number !== undefined) {
      await callTool('github', 'add_issue_comment', {
        owner: payload._owner,
        repo: payload._repo,
        issue_number: payload._issue_number,
        body: `mypa opened a PR for this.${linkLine}`
      })
    }
  } catch (err) {
    const message = (err as Error).message
    const error = prUrl
      ? `PR opened (${prUrl}) but a later step failed: ${message}`
      : pushed
        ? `Branch pushed, but opening the PR failed: ${message}`
        : `Ship failed before pushing: ${message}`
    broadcastWorkProduct(dbUpdateWorkProduct(wp.id, { status: 'failed', error })!)
    dbAppendActionLog({
      intent_id: intentId, event: 'failed', action_type: actionType, tier: intent.tier,
      detail: { error, pushed, pr_url: prUrl }, created_at: new Date().toISOString()
    })
    throw err
  }

  const shipped_at = new Date().toISOString()
  broadcastWorkProduct(dbUpdateWorkProduct(wp.id, { status: 'shipped', shipped_at, error: null })!)
  dbUpdateIntentStatus(intentId, 'executed')
  recordExecution(actionType)
  dbAppendActionLog({
    intent_id: intentId,
    event: 'executed',
    action_type: actionType,
    tier: intent.tier,
    detail: { pr_url: prUrl },
    created_at: shipped_at
  })
  return dbGetIntent(intentId)!
}

/**
 * Abandons a work product: prunes its worktree (and local branch) and dismisses
 * the intent. Safe to call before authoring has produced a worktree at all — in
 * that case it's equivalent to a plain dismiss.
 */
export async function discardWorkProduct(intentId: string): Promise<void> {
  if (inFlightAuthoring.has(intentId)) {
    throw new Error('Authoring is still running for this intent — wait for it to finish before discarding.')
  }
  const wp = dbGetWorkProductByIntent(intentId)
  if (wp && wp.status !== 'abandoned' && wp.status !== 'shipped') {
    const repoLink = getRepoLink(wp.repo_id)
    if (repoLink) {
      await pruneWorktree(repoLink.localPath, wp.worktree_path, wp.branch, true)
    }
    broadcastWorkProduct(dbUpdateWorkProduct(wp.id, { status: 'abandoned' })!)
  }
  ambientDismissIntent(intentId)
}
