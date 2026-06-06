import React, { useState } from 'react'
import { GitBranch, SquareKanban, MessageSquare } from 'lucide-react'
import type { Intent } from '../../../../../../shared/types'

interface Props {
  intent: Intent
  onIntentChange: (updated: Intent) => void
}

function SurfaceIcon({ surface }: { surface: string | null }): React.ReactElement {
  const size = 12
  if (surface === 'github') return <GitBranch size={size} strokeWidth={2} />
  if (surface === 'jira') return <SquareKanban size={size} strokeWidth={2} />
  return <MessageSquare size={size} strokeWidth={2} />
}

function formatAge(iso: string): string {
  const ms = Date.now() - Date.parse(iso)
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

const TERMINAL_STATUSES: Intent['status'][] = ['executed', 'dismissed', 'challenged', 'failed', 'expired']

export default function IntentCard({ intent, onIntentChange }: Props): React.ReactElement {
  const [challenging, setChallenging] = useState(false)
  const [challengeReason, setChallengeReason] = useState('')
  const [loading, setLoading] = useState(false)

  const api = window.electron
  const isTerminal = TERMINAL_STATUSES.includes(intent.status)
  const needsApproval = intent.required_approval && intent.tier >= 2

  const cardClass = [
    'routine-card',
    needsApproval && !isTerminal ? 'routine-card--pending' : '',
    isTerminal ? 'routine-card--resolved' : '',
    intent.status === 'failed' ? 'routine-card--error' : ''
  ].filter(Boolean).join(' ')

  const dotClass = `routine-card__dot routine-card__dot--${
    isTerminal ? (intent.status === 'executed' ? 'resolved' : 'dismissed')
    : needsApproval ? 'pending'
    : 'running'
  }`

  const confidencePct = Math.round(intent.confidence * 100)
  const tierLabel = ['Silent', 'Notify', 'Approve', 'Locked'][intent.tier] ?? 'Approve'

  async function handleApprove(): Promise<void> {
    setLoading(true)
    try {
      const updated = await api.ambient.approve(intent.id)
      onIntentChange(updated as Intent)
    } catch (e) {
      console.error('approve error:', e)
    } finally {
      setLoading(false)
    }
  }

  async function handleDismiss(): Promise<void> {
    await api.ambient.dismiss(intent.id)
    onIntentChange({ ...intent, status: 'dismissed' })
  }

  async function handleChallenge(): Promise<void> {
    if (!challengeReason.trim()) return
    setLoading(true)
    try {
      const updated = await api.ambient.challenge(intent.id, challengeReason)
      onIntentChange(updated as Intent)
      setChallenging(false)
      setChallengeReason('')
    } catch (e) {
      console.error('challenge error:', e)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={cardClass}>
      <div className="routine-card__header" style={{ cursor: 'default' }}>
        <span className={dotClass} />
        <div className="routine-card__meta">
          <div className="routine-card__name" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <SurfaceIcon surface={intent.surface} />
            <span>{intent.rationale}</span>
          </div>

          {/* Chips row */}
          <div className="intent-card__chips">
            {/* Confidence */}
            <span
              className="intent-chip intent-chip--accent"
              title={`Confidence: ${confidencePct}%`}
            >
              {confidencePct}%
            </span>

            {/* Reversibility */}
            {intent.reversibility === 'irreversible' && (
              <span className="intent-chip intent-chip--warning">irreversible</span>
            )}

            {/* Tier */}
            <span className="intent-chip intent-chip--muted">{tierLabel}</span>

            {/* Target */}
            {intent.target && (
              <span className="intent-chip intent-chip--muted" style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {intent.target}
              </span>
            )}
          </div>
        </div>

        <span className="routine-card__time">{formatAge(intent.created_at)}</span>
      </div>

      {/* Status line for terminal states */}
      {isTerminal && (
        <div className="routine-card__body" style={{ fontSize: 11, color: 'var(--text-muted)', paddingTop: 0 }}>
          {intent.status === 'executed' ? '✓ Executed' :
           intent.status === 'challenged' ? '✗ Challenged' :
           intent.status === 'dismissed' ? 'Dismissed' :
           intent.status === 'failed' ? `Failed: ${intent.error ?? ''}` : intent.status}
        </div>
      )}

      {/* Challenge input */}
      {challenging && !isTerminal && (
        <div className="routine-card__body" style={{ paddingTop: 4 }}>
          <textarea
            className="review-field__input"
            placeholder="Why isn't this right? This teaches the agent."
            value={challengeReason}
            onChange={(e) => setChallengeReason(e.target.value)}
            rows={2}
            autoFocus
            style={{ width: '100%', resize: 'none', marginBottom: 6 }}
          />
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button
              className="btn btn--ghost"
              onClick={() => { setChallenging(false); setChallengeReason('') }}
              style={{ fontSize: 11 }}
            >
              Cancel
            </button>
            <button
              className="btn btn--danger"
              onClick={handleChallenge}
              disabled={!challengeReason.trim() || loading}
              style={{ fontSize: 11 }}
            >
              Send challenge
            </button>
          </div>
        </div>
      )}

      {/* Action footer */}
      {!isTerminal && !challenging && (
        <div className="routine-card__body" style={{ paddingTop: 0, display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <button
            className="btn btn--ghost"
            onClick={handleDismiss}
            disabled={loading}
            style={{ fontSize: 11 }}
          >
            Dismiss
          </button>
          <button
            className="btn btn--danger"
            onClick={() => setChallenging(true)}
            disabled={loading}
            style={{ fontSize: 11 }}
          >
            Challenge
          </button>
          {needsApproval && (
            <button
              className="btn btn--primary"
              onClick={handleApprove}
              disabled={loading}
              style={{ fontSize: 11 }}
            >
              Approve
            </button>
          )}
        </div>
      )}
    </div>
  )
}
