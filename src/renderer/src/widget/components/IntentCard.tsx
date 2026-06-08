import React, { useState } from 'react'
import { GitBranch, SquareKanban, MessageSquare, ChevronDown } from 'lucide-react'
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

const VERB_LABELS: Record<string, string> = {
  comment: 'Comment',
  label: 'Label',
  close: 'Close',
  assign: 'Assign',
  merge: 'Merge',
  reply: 'Reply',
  send: 'Send',
  summarize: 'Summarize',
}

const TIER_LABELS = ['Silent', 'Notify', 'Approve', 'Locked']

// Safely coerce an unknown value to a typed array using an item guard
function safeArray<T>(val: unknown, guard: (x: unknown) => x is T): T[] {
  if (!Array.isArray(val)) return []
  return val.filter(guard)
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

function hasString(x: unknown, key: string): x is Record<string, unknown> & { [k: string]: string } {
  return isRecord(x) && typeof (x as Record<string, unknown>)[key] === 'string'
}

export default function IntentCard({ intent, onIntentChange }: Props): React.ReactElement {
  const [expanded, setExpanded] = useState(false)
  const [challenging, setChallenging] = useState(false)
  const [challengeReason, setChallengeReason] = useState('')
  const [loading, setLoading] = useState(false)
  const [challengeConfirmed, setChallengeConfirmed] = useState(false)

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
  const tierLabel = TIER_LABELS[intent.tier] ?? 'Approve'
  const verbLabel = intent.verb ? (VERB_LABELS[intent.verb] ?? intent.verb) : null

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
      setChallengeConfirmed(true)
      setTimeout(() => setChallengeConfirmed(false), 3500)
    } catch (e) {
      console.error('challenge error:', e)
    } finally {
      setLoading(false)
    }
  }

  // ── Expand detail helpers ──────────────────────────────────────────────────

  const payload = intent.payload ?? {}
  const payloadTextKey = ['body', 'text', 'comment', 'message'].find((k) => typeof payload[k] === 'string')
  const payloadText = payloadTextKey ? String(payload[payloadTextKey]) : null
  const payloadExtra = Object.entries(payload).filter(([k]) => k !== payloadTextKey)

  const cp = intent.context_packet ?? {}
  const memories = safeArray(cp.memories, isRecord)
  const recentSignals = safeArray(cp.recentSignals, isRecord)
  const focusNodes = safeArray(cp.focusNodes, isRecord)
  const hasContext = memories.length > 0 || recentSignals.length > 0 || focusNodes.length > 0

  return (
    <div className={cardClass}>
      {/* ── Header ── */}
      <div
        className="routine-card__header"
        onClick={() => setExpanded((e) => !e)}
        style={{ cursor: 'pointer' }}
      >
        <span className={dotClass} />
        <div className="routine-card__meta">
          {/* 2-line title */}
          <div className="intent-card__title">
            <SurfaceIcon surface={intent.surface} />
            <span>{intent.rationale}</span>
          </div>

          {/* Proposed action line */}
          {(verbLabel || intent.target) && (
            <div className="intent-card__action">
              {verbLabel && <span className="intent-card__action-verb">{verbLabel}</span>}
              {verbLabel && intent.target && <span className="intent-card__action-sep"> · </span>}
              {intent.target && <span>{intent.target}</span>}
            </div>
          )}

          {/* Slim chip row — just the high-signal at-a-glance info */}
          <div className="intent-card__chips">
            <span
              className="intent-chip intent-chip--accent"
              title={`Confidence: ${confidencePct}%`}
            >
              {confidencePct}%
            </span>
            {needsApproval && !isTerminal && (
              <span className="intent-chip intent-chip--muted">needs approval</span>
            )}
            {intent.reversibility === 'irreversible' && (
              <span className="intent-chip intent-chip--warning">irreversible</span>
            )}
          </div>
        </div>

        <span className="routine-card__time">{formatAge(intent.created_at)}</span>
        <span className={`routine-card__expand-icon${expanded ? ' open' : ''}`}>
          <ChevronDown size={12} />
        </span>
      </div>

      {/* ── Expanded detail block ── */}
      {expanded && (
        <div className="routine-card__body intent-detail">
          {/* Why this surfaced */}
          <div className="intent-detail__section">
            <div className="intent-detail__label">Why this surfaced</div>
            <div className="intent-detail__text">{intent.rationale}</div>
          </div>

          {/* Proposed action */}
          {(verbLabel || intent.target || payloadText || payloadExtra.length > 0) && (
            <div className="intent-detail__section">
              <div className="intent-detail__label">Proposed action</div>
              {(verbLabel || intent.target) && (
                <div className="intent-detail__action-line">
                  {[verbLabel, intent.target].filter(Boolean).join(' · ')}
                </div>
              )}
              <div className="intent-detail__meta-row">
                <span>{tierLabel}</span>
                {intent.reversibility === 'irreversible' && (
                  <span style={{ color: 'var(--yellow)' }}>· irreversible</span>
                )}
              </div>
              {payloadText && (
                <div className="intent-detail__quote">{payloadText}</div>
              )}
              {payloadExtra.length > 0 && (
                <div className="intent-detail__kv">
                  {payloadExtra.map(([k, v]) => (
                    <div key={k} className="intent-detail__kv-row">
                      <span className="intent-detail__kv-key">{k}</span>
                      <span className="intent-detail__kv-val">{String(v)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Context */}
          {hasContext && (
            <div className="intent-detail__section">
              <div className="intent-detail__label">Context</div>
              {memories.length > 0 && (
                <div className="intent-detail__ctx-group">
                  <div className="intent-detail__ctx-heading">Known facts</div>
                  {memories.slice(0, 4).map((m, i) => (
                    <div key={i} className="intent-detail__ctx-row">
                      · {hasString(m, 'content') ? m.content : JSON.stringify(m)}
                    </div>
                  ))}
                </div>
              )}
              {recentSignals.length > 0 && (
                <div className="intent-detail__ctx-group">
                  <div className="intent-detail__ctx-heading">Recent activity</div>
                  {recentSignals.slice(0, 5).map((s, i) => {
                    const surface = hasString(s, 'surface') ? s.surface : ''
                    const kind = hasString(s, 'kind') ? s.kind : ''
                    const title = hasString(s, 'title') ? s.title : ''
                    const prefix = [surface, kind].filter(Boolean).join(':')
                    return (
                      <div key={i} className="intent-detail__ctx-row">
                        · {prefix ? <span style={{ color: 'var(--text-muted)' }}>[{prefix}]</span> : null} {title}
                      </div>
                    )
                  })}
                </div>
              )}
              {focusNodes.length > 0 && (
                <div className="intent-detail__ctx-group">
                  <div className="intent-detail__ctx-heading">Focus</div>
                  {focusNodes.slice(0, 3).map((n, i) => (
                    <div key={i} className="intent-detail__ctx-row">
                      · {hasString(n, 'label') ? n.label : JSON.stringify(n)}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Status line for terminal states ── */}
      {isTerminal && (
        <div className="routine-card__body" style={{ fontSize: 11, color: 'var(--text-muted)', paddingTop: 0 }}>
          {intent.status === 'executed' ? 'Executed' :
           intent.status === 'challenged' ? (
             <>
               <span>Challenged</span>
               {intent.challenge_reason && (
                 <div className="intent-detail__quote" style={{ marginTop: 4, fontSize: 11 }}>
                   {intent.challenge_reason}
                 </div>
               )}
             </>
           ) :
           intent.status === 'dismissed' ? 'Dismissed' :
           intent.status === 'failed' ? `Failed: ${intent.error ?? ''}` : intent.status}
        </div>
      )}

      {/* ── Challenge confirmation banner ── */}
      {challengeConfirmed && (
        <div className="routine-card__body" style={{ fontSize: 11, color: 'var(--green)', paddingTop: 0 }}>
          Challenge recorded — {intent.surface}:{intent.verb} will ask for approval more often
        </div>
      )}

      {/* ── Challenge input ── */}
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

      {/* ── Action footer ── */}
      {!isTerminal && !challenging && (
        <div className="routine-card__body" style={{ paddingTop: 0, display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <button
            className="btn btn--ghost"
            onClick={(e) => { e.stopPropagation(); handleDismiss() }}
            disabled={loading}
            style={{ fontSize: 11 }}
          >
            Dismiss
          </button>
          <button
            className="btn btn--danger"
            onClick={(e) => { e.stopPropagation(); setChallenging(true) }}
            disabled={loading}
            style={{ fontSize: 11 }}
          >
            Challenge
          </button>
          {needsApproval && (
            <button
              className="btn btn--primary"
              onClick={(e) => { e.stopPropagation(); handleApprove() }}
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
