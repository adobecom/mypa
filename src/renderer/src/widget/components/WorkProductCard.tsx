import React, { useEffect, useState } from 'react'
import { GitBranch, SquareKanban, ChevronDown, ExternalLink, FileDiff, Wrench } from 'lucide-react'
import type { Intent, WorkProduct } from '@shared/types'

interface Props {
  intent: Intent
  onIntentChange: (updated: Intent) => void
}

const TERMINAL_STATUSES: Intent['status'][] = ['executed', 'dismissed', 'challenged', 'failed', 'expired']

function formatAge(iso: string): string {
  const ms = Date.now() - Date.parse(iso)
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function SurfaceIcon({ surface }: { surface: string | null }): React.ReactElement {
  const size = 12
  if (surface === 'jira') return <SquareKanban size={size} strokeWidth={2} />
  return <GitBranch size={size} strokeWidth={2} />
}

/**
 * Card for an `author_fix` intent — mypa attempting a real code change in an
 * isolated git worktree, rather than a comment/label/message. Shown in place of
 * IntentCard for this verb (see QueueView). Lifecycle: no work product yet (tap
 * Start) → drafting (agent running) → ready (review diff, tap Ship it) →
 * shipping → shipped, or failed/abandoned. See authoring.ts for the backing flow.
 */
export default function WorkProductCard({ intent, onIntentChange }: Props): React.ReactElement {
  const api = window.electron
  // undefined = not yet loaded; null = loaded, confirmed no work product exists yet.
  const [wp, setWp] = useState<WorkProduct | null | undefined>(undefined)
  const [starting, setStarting] = useState(false)
  const [shipping, setShipping] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [diffOpen, setDiffOpen] = useState(false)

  const isTerminal = TERMINAL_STATUSES.includes(intent.status)

  useEffect(() => {
    api.ambient.getWorkProduct(intent.id)
      .then((result) => setWp(result))
      .catch(console.error)
  }, [intent.id])

  useEffect(() => {
    const off = api.on('ambient:work-product-updated', (payload) => {
      const updated = payload as WorkProduct
      if (updated.intent_id !== intent.id) return
      setWp(updated)
    })
    return off
  }, [intent.id])

  async function handleStart(): Promise<void> {
    setStarting(true)
    setError(null)
    // Optimistic: reflect the approval immediately; the authoritative update
    // arrives via the ambient:intent-updated broadcast either way.
    onIntentChange({ ...intent, status: 'approved' })
    try {
      const result = await api.ambient.startAuthoring(intent.id)
      setWp(result)
    } catch (e: any) {
      setError(e?.message ?? 'Could not start authoring.')
    } finally {
      setStarting(false)
    }
  }

  async function handleShip(): Promise<void> {
    setShipping(true)
    setError(null)
    try {
      const updated = await api.ambient.shipWorkProduct(intent.id)
      onIntentChange(updated)
      // No explicit refetch needed here — authoring.ts broadcasts the work product
      // at every stage of shipping via ambient:work-product-updated, which the
      // subscription effect above already applies to `wp`.
    } catch (e: any) {
      setError(e?.message ?? 'Could not ship this change.')
    } finally {
      setShipping(false)
    }
  }

  async function handleDiscard(): Promise<void> {
    setDiscarding(true)
    try {
      await api.ambient.discardWorkProduct(intent.id)
      onIntentChange({ ...intent, status: 'dismissed' })
    } catch (e) {
      console.error('discardWorkProduct error:', e)
    } finally {
      setDiscarding(false)
    }
  }

  const status = wp?.status
  const dotClass = `routine-card__dot routine-card__dot--${
    isTerminal || status === 'abandoned' ? 'dismissed'
    : status === 'shipped' ? 'resolved'
    : status === 'failed' ? 'error'
    : status === 'drafting' || status === 'shipping' ? 'running'
    : 'pending'
  }`

  const statusLabel =
    wp === undefined ? 'Loading…'
    : !wp ? 'Attempt a fix?'
    : status === 'drafting' ? 'Authoring in progress…'
    : status === 'ready' ? 'Ready for review'
    : status === 'shipping' ? 'Shipping…'
    : status === 'shipped' ? 'Shipped'
    : status === 'failed' ? 'Failed'
    : status === 'abandoned' ? 'Discarded'
    : status

  return (
    <div className={`routine-card${!isTerminal && (wp?.status === 'ready' || !wp) ? ' routine-card--pending' : ''}`}>
      <div className="routine-card__header">
        <span className={dotClass} />
        <div className="routine-card__meta">
          <div className="intent-card__title">
            <SurfaceIcon surface={intent.surface} />
            <span>{intent.target || 'Attempt a fix'}</span>
          </div>
          {intent.rationale && (
            <div className="intent-card__action">
              <span style={{ color: 'var(--text-muted)' }}>{intent.rationale}</span>
            </div>
          )}
          <div className="intent-card__chips">
            <span className="intent-chip intent-chip--muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <Wrench size={9} strokeWidth={2} />
              {statusLabel}
            </span>
            {wp && wp.diff_stat && <span className="intent-chip intent-chip--muted">{wp.diff_stat.split('\n')[0]}</span>}
          </div>
        </div>
        <span className="routine-card__time">{formatAge(intent.created_at)}</span>
      </div>

      <div className="routine-card__body">
        {/* No work product yet — plain-language task description the agent will attempt */}
        {!wp && intent.payload && typeof (intent.payload as Record<string, unknown>).task_description === 'string' && (
          <div className="intent-detail__section">
            <div className="intent-detail__label">What mypa would attempt</div>
            <div className="intent-detail__quote">{String((intent.payload as Record<string, unknown>).task_description)}</div>
          </div>
        )}

        {/* Ready / shipped — diff summary */}
        {wp && wp.summary && (
          <div className="intent-detail__section">
            <div className="intent-detail__label">Summary</div>
            <div className="intent-detail__quote">{wp.summary}</div>
          </div>
        )}

        {wp && wp.files_changed.length > 0 && (
          <div className="intent-detail__section">
            <div
              className="intent-detail__label"
              style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}
              onClick={() => setDiffOpen((o) => !o)}
            >
              <FileDiff size={11} />
              {wp.files_changed.length} file{wp.files_changed.length === 1 ? '' : 's'} changed
              <ChevronDown size={11} style={{ transform: diffOpen ? 'rotate(180deg)' : undefined }} />
            </div>
            <ul className="intent-detail__kv-list">
              {wp.files_changed.map((f) => <li key={f}>{f}</li>)}
            </ul>
            {diffOpen && wp.diff && (
              <pre className="intent-detail__kv-val intent-detail__kv-pre">{wp.diff.slice(0, 20_000)}</pre>
            )}
          </div>
        )}

        {wp?.pr_url && (
          <div className="intent-detail__section">
            <span
              className="intent-card__title-link"
              onClick={() => window.electron.system.openExternal(wp.pr_url!)}
            >
              <span>{wp.pr_url}</span>
              <ExternalLink size={11} className="intent-card__title-link-icon" />
            </span>
          </div>
        )}

        {(error || wp?.error) && (
          <div className="intent-detail__section" style={{ color: 'var(--red)', fontSize: 11 }}>
            {error ?? wp?.error}
          </div>
        )}
      </div>

      {/* Not yet started — only meaningful while the intent itself is still actionable. */}
      {!isTerminal && wp === null && (
        <div className="routine-card__body" style={{ paddingTop: 10, display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <button className="btn btn--ghost" onClick={handleDiscard} disabled={discarding} style={{ fontSize: 11 }}>
            Dismiss
          </button>
          <button className="btn btn--primary" onClick={handleStart} disabled={starting} style={{ fontSize: 11 }}>
            {starting ? 'Starting…' : 'Start'}
          </button>
        </div>
      )}

      {wp?.status === 'ready' && (
        <div className="routine-card__body" style={{ paddingTop: 10, display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <button className="btn btn--ghost" onClick={handleDiscard} disabled={discarding} style={{ fontSize: 11 }}>
            Discard
          </button>
          <button className="btn btn--primary" onClick={handleShip} disabled={shipping} style={{ fontSize: 11 }}>
            {shipping ? 'Shipping…' : 'Ship it'}
          </button>
        </div>
      )}

      {/* Discard is offered even while "drafting" (escape hatch if a run looks stuck,
          e.g. after an app restart) and even though a "failed" work product also makes
          the intent terminal (per the same failed=terminal convention every other verb
          uses) — otherwise a failed/stuck run would have no way to free its worktree. */}
      {(wp?.status === 'drafting' || wp?.status === 'failed') && (
        <div className="routine-card__body" style={{ paddingTop: 10, display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <button
            className="btn btn--ghost"
            onClick={handleDiscard}
            disabled={discarding}
            style={{ fontSize: 11 }}
            title={wp.status === 'drafting' ? 'If this looks stuck (e.g. after an app restart), discard to free the worktree.' : undefined}
          >
            Discard
          </button>
        </div>
      )}

      {isTerminal && (
        <div className="routine-card__body" style={{ fontSize: 11, color: 'var(--text-muted)', paddingTop: 0 }}>
          {intent.status === 'executed' ? 'Shipped' : intent.status === 'dismissed' ? 'Discarded' : intent.status}
        </div>
      )}
    </div>
  )
}
