import React, { useState, useEffect } from 'react'
import { GitBranch, SquareKanban, MessageSquare, ChevronDown, Lightbulb, Zap, MessagesSquare } from 'lucide-react'
import type { Intent, ChatMessage, RoutineRun } from '../../../../../../shared/types'
import MarkdownText from '@renderer/components/MarkdownText'
import Tabs from '@renderer/components/Tabs'
import ChatThread from './ChatThread'
import { useAutoGrowTextarea } from '@renderer/hooks/useAutoGrowTextarea'

interface Props {
  intent: Intent
  onIntentChange: (updated: Intent) => void
  /** Maps a work-item key to the routine runs that cover it. */
  entityKeyToRuns?: Map<string, RoutineRun[]>
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

const VERB_LABELS: Record<string, string | null> = {
  comment: 'Comment',
  label: 'Label',
  close: 'Close',
  assign: 'Assign',
  merge: 'Merge',
  reply: 'Reply',
  send: 'Send',
  summarize: 'Summarize',
  none: null,
}

const TYPE_LABELS: Record<string, string> = {
  action: 'Action',
  suggestion: 'Observation',
  flag: 'Flag',
  digest: 'Digest',
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

function renderPayloadVal(v: unknown): React.ReactNode {
  if (Array.isArray(v)) {
    if (v.length === 0) return <span className="intent-detail__kv-val">—</span>
    const allPrimitive = v.every((item) => typeof item !== 'object' || item === null)
    if (allPrimitive) {
      return <span className="intent-detail__kv-val">{v.map(String).join(', ')}</span>
    }
    return (
      <ul className="intent-detail__kv-list">
        {v.map((item, i) => {
          const label =
            hasString(item, 'title') ? item.title
            : hasString(item, 'name') ? item.name
            : isRecord(item) && typeof item.number !== 'undefined' ? `#${item.number}`
            : `#${i + 1}`
          return <li key={i}>{label}</li>
        })}
      </ul>
    )
  }
  if (isRecord(v)) {
    return <pre className="intent-detail__kv-val intent-detail__kv-pre">{JSON.stringify(v, null, 2)}</pre>
  }
  return <span className="intent-detail__kv-val">{String(v)}</span>
}

export default function IntentCard({ intent, onIntentChange, entityKeyToRuns }: Props): React.ReactElement {
  // Auto-expand cards that have a draft body for the user to review before sending
  const hasDraft = ['body', 'text', 'comment', 'message'].some(
    (k) => typeof (intent.payload ?? {})[k] === 'string' && String((intent.payload ?? {})[k]).trim()
  )
  const [expanded, setExpanded] = useState(hasDraft && intent.required_approval && !TERMINAL_STATUSES.includes(intent.status))
  const [detailTab, setDetailTab] = useState('why')
  const [challenging, setChallenging] = useState(false)
  const [challengeReason, setChallengeReason] = useState('')
  const [loading, setLoading] = useState(false)
  const [challengeConfirmed, setChallengeConfirmed] = useState(false)
  const [suggesting, setSuggesting] = useState(false)
  const [suggestThread, setSuggestThread] = useState<ChatMessage[]>([])
  const [suggestStreaming, setSuggestStreaming] = useState(false)
  const [suggestError, setSuggestError] = useState<string | null>(null)

  // ── "Chat about it" state ─────────────────────────────────────────────────
  const [chatOpen, setChatOpen] = useState(false)
  const [chatThread, setChatThread] = useState<ChatMessage[]>([])
  const [chatStreaming, setChatStreaming] = useState(false)
  const [chatStreamContent, setChatStreamContent] = useState('')
  const [chatError, setChatError] = useState<string | null>(null)

  const api = window.electron
  const isTerminal = TERMINAL_STATUSES.includes(intent.status)
  const isObservation = intent.type === 'suggestion' || intent.type === 'flag'
  const needsApproval = !isObservation && intent.required_approval && intent.tier >= 2
  const agentWillHandle = !isObservation && !needsApproval && !isTerminal && intent.tier <= 1

  // Editable draft — initialized from the payload's body/text/comment/message field
  const payloadDraftKey = ['body', 'text', 'comment', 'message'].find(
    (k) => typeof (intent.payload ?? {})[k] === 'string'
  )
  const [draftText, setDraftText] = useState<string>(
    payloadDraftKey ? String((intent.payload ?? {})[payloadDraftKey]) : ''
  )
  const draftRef = useAutoGrowTextarea(draftText)
  const challengeRef = useAutoGrowTextarea(challengeReason)

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
  const typeLabel = TYPE_LABELS[intent.type] ?? intent.type
  const verbLabel = intent.verb && intent.verb !== 'none' ? (VERB_LABELS[intent.verb] ?? intent.verb) : null

  async function handleApprove(): Promise<void> {
    setLoading(true)
    try {
      // Pass the user-edited draft text back as the updated payload so the agent
      // executes the reviewed, edited version rather than the original draft.
      let editedPayload: Record<string, unknown> | undefined
      if (payloadDraftKey && draftText.trim()) {
        editedPayload = { ...(intent.payload ?? {}), [payloadDraftKey]: draftText }
      }
      const updated = await api.ambient.approve(intent.id, editedPayload)
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

  // ── Suggest thread ────────────────────────────────────────────────────────

  // Load existing thread when the Suggest panel opens for the first time
  useEffect(() => {
    if (!suggesting || suggestThread.length > 0) return
    api.ambient.getIntentThread(intent.id)
      .then((msgs) => setSuggestThread(msgs as ChatMessage[]))
      .catch(console.error)
  }, [suggesting])

  // Subscribe to assistant replies streamed through the broadcast channel
  useEffect(() => {
    const off = api.on('ambient:intent-message', (payload) => {
      const p = payload as { intentId: string; message: string }
      if (p.intentId !== intent.id) return
      setSuggestStreaming(false)
      setSuggestThread((prev) => [
        ...prev,
        { id: Date.now().toString(), role: 'assistant' as const, content: p.message, timestamp: new Date().toISOString() }
      ])
    })
    return off
  }, [intent.id])

  async function handleSuggest(message: string): Promise<void> {
    setSuggestError(null)
    setSuggestStreaming(true)
    // Optimistically show user message
    const optimisticId = Date.now().toString()
    setSuggestThread((prev) => [
      ...prev,
      { id: optimisticId, role: 'user' as const, content: message, timestamp: new Date().toISOString() }
    ])
    try {
      const result = await api.ambient.suggest(intent.id, message)
      if (result) {
        onIntentChange(result.intent as Intent)
        // Update draft text to the new proposal if it has a payload body
        const newPayload = (result.intent as Intent).payload ?? {}
        const newDraftKey = ['body', 'text', 'comment', 'message'].find(
          (k) => typeof newPayload[k] === 'string'
        )
        if (newDraftKey) {
          setDraftText(String(newPayload[newDraftKey]))
        }
      }
    } catch (e: any) {
      setSuggestError(e?.message ?? 'Failed to get a re-proposal.')
      setSuggestStreaming(false)
    }
  }

  // ── "Chat about it" handlers ──────────────────────────────────────────────

  // Load existing chat thread when the panel opens for the first time
  useEffect(() => {
    if (!chatOpen || chatThread.length > 0) return
    api.ambient.getChatThread(intent.id)
      .then((msgs) => setChatThread(msgs as ChatMessage[]))
      .catch(console.error)
  }, [chatOpen])

  // Subscribe to user-message echoes from the main process
  useEffect(() => {
    const off = api.on('ambient:chat-user-message', (payload) => {
      const p = payload as { intentId: string; message: ChatMessage }
      if (p.intentId !== intent.id) return
      setChatThread((prev) => [...prev, p.message])
      setChatStreaming(true)
      setChatStreamContent('')
    })
    return off
  }, [intent.id])

  // Subscribe to streamed assistant reply chunks
  useEffect(() => {
    const off = api.on('ambient:chat-message', (payload) => {
      const p = payload as { intentId: string; chunk: string; done: boolean; error?: string }
      if (p.intentId !== intent.id) return
      if (p.done) {
        setChatStreaming(false)
        if (p.error) {
          setChatError(p.error)
        } else {
          // Re-fetch the thread so persisted assistant messages appear correctly
          api.ambient.getChatThread(intent.id)
            .then((msgs) => {
              setChatThread(msgs as ChatMessage[])
              setChatStreamContent('')
            })
            .catch(console.error)
        }
      } else {
        setChatStreamContent((prev) => prev + p.chunk)
      }
    })
    return off
  }, [intent.id])

  async function handleChatSend(message: string): Promise<void> {
    setChatError(null)
    await api.ambient.sendChatMessage(intent.id, message)
  }

  function handleChatStop(): void {
    api.ambient.cancelChatStream(intent.id).catch(console.error)
  }

  // ── Expand detail helpers ──────────────────────────────────────────────────

  const payload = intent.payload ?? {}
  const payloadTextKey = payloadDraftKey  // same key, kept for clarity in JSX below
  const payloadText = payloadTextKey ? String(payload[payloadTextKey]) : null
  // Exclude the display key and any _-prefixed internal routing fields (e.g. _channel_id)
  const payloadExtra = Object.entries(payload).filter(([k]) => k !== payloadTextKey && !k.startsWith('_'))

  const cp = intent.context_packet ?? {}
  const memories = safeArray(cp.memories, isRecord)
  const recentSignals = safeArray(cp.recentSignals, isRecord)
  const focusNodes = safeArray(cp.focusNodes, isRecord)

  // Derive the set of routine runs that cover at least one of this intent's focus nodes.
  // Deduplicated by run id so each routine name appears at most once.
  const linkedRuns: RoutineRun[] = (() => {
    if (!entityKeyToRuns) return []
    const seen = new Set<string>()
    const result: RoutineRun[] = []
    for (const node of focusNodes) {
      if (!hasString(node, 'key')) continue
      const runs = entityKeyToRuns.get(node.key) ?? []
      for (const run of runs) {
        if (!seen.has(run.id)) {
          seen.add(run.id)
          result.push(run)
        }
      }
    }
    return result
  })()

  const detailTabItems = [
    { id: 'why', label: 'Why' },
    ...(recentSignals.length > 0 ? [{ id: 'activity', label: 'Activity' }] : []),
    ...(memories.length > 0 ? [{ id: 'facts', label: 'Facts' }] : []),
    ...(focusNodes.length > 0 ? [{ id: 'focus', label: 'Focus' }] : []),
  ]
  // Fall back to 'why' if the active tab no longer has data (e.g. intent updated in-place)
  const activeDetailTab = detailTabItems.some((t) => t.id === detailTab) ? detailTab : 'why'

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
            <span className="intent-chip intent-chip--muted">{typeLabel}</span>
            {needsApproval && !isTerminal && (
              <span className="intent-chip intent-chip--muted">needs approval</span>
            )}
            {agentWillHandle && (
              <span className="intent-chip intent-chip--muted">agent will handle</span>
            )}
            {intent.reversibility === 'irreversible' && (
              <span className="intent-chip intent-chip--warning">irreversible</span>
            )}
            {linkedRuns.map((run) => (
              <span
                key={run.id}
                className="intent-chip intent-chip--muted"
                title={`Also in routine run: ${run.routine_name}`}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}
              >
                <Zap size={9} strokeWidth={2} />
                {run.routine_name}
              </span>
            ))}
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
          {/* Proposed action — always visible */}
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
              {payloadText !== null && !isTerminal && (
                <textarea
                  ref={draftRef}
                  className="intent-detail__draft"
                  value={draftText}
                  onChange={(e) => setDraftText(e.target.value)}
                  rows={1}
                  placeholder="Edit draft before sending…"
                  style={{ width: '100%', resize: 'none', marginTop: 6, boxSizing: 'border-box' }}
                />
              )}
              {payloadText !== null && isTerminal && (
                <MarkdownText className="intent-detail__quote">{payloadText}</MarkdownText>
              )}
              {payloadExtra.length > 0 && (
                <div className="intent-detail__kv">
                  {payloadExtra.map(([k, v]) => (
                    <div key={k} className="intent-detail__kv-row">
                      <span className="intent-detail__kv-key">{k}</span>
                      {renderPayloadVal(v)}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Context tabs — Why / Activity / Facts / Focus */}
          <div className="intent-detail__section">
            <Tabs
              items={detailTabItems}
              active={activeDetailTab}
              onChange={setDetailTab}
              className="intent-detail__tabs"
            />
            {activeDetailTab === 'why' && (
              <MarkdownText className="intent-detail__text">{intent.rationale}</MarkdownText>
            )}
            {activeDetailTab === 'activity' && (
              <div className="intent-detail__ctx-group">
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
            {activeDetailTab === 'facts' && (
              <div className="intent-detail__ctx-group">
                {memories.slice(0, 4).map((m, i) => (
                  <div key={i} className="intent-detail__ctx-row">
                    · {hasString(m, 'content') ? m.content : JSON.stringify(m)}
                  </div>
                ))}
              </div>
            )}
            {activeDetailTab === 'focus' && (
              <div className="intent-detail__ctx-group">
                {focusNodes.slice(0, 3).map((n, i) => (
                  <div key={i} className="intent-detail__ctx-row">
                    · {hasString(n, 'label') ? n.label : JSON.stringify(n)}
                  </div>
                ))}
              </div>
            )}
          </div>
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
                 <MarkdownText className="intent-detail__quote">{intent.challenge_reason}</MarkdownText>
               )}
             </>
           ) :
           intent.status === 'dismissed' ? 'Dismissed' :
           intent.status === 'expired' ? (intent.error ?? 'No longer relevant') :
           intent.status === 'failed' ? `Failed: ${intent.error ?? ''}` : intent.status}
        </div>
      )}

      {/* ── Challenge confirmation banner ── */}
      {challengeConfirmed && (
        <div className="routine-card__body" style={{ fontSize: 11, color: 'var(--green)', paddingTop: 0 }}>
          {isObservation
            ? 'Feedback recorded — will surface fewer observations like this'
            : `Challenge recorded — ${intent.surface}:${intent.verb} will ask for approval more often`}
        </div>
      )}

      {/* ── Suggest thread panel ── */}
      {suggesting && !isTerminal && (
        <div className="routine-card__body" style={{ paddingTop: 4 }}>
          <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-muted)', marginBottom: 6 }}>
            Suggest improvements
          </div>
          <ChatThread
            messages={suggestThread}
            streaming={suggestStreaming}
            onSend={handleSuggest}
            error={suggestError}
            sendDisabled={suggestStreaming}
          />
          <div style={{ marginTop: 6, display: 'flex', justifyContent: 'flex-end' }}>
            <button
              className="btn btn--ghost"
              onClick={() => setSuggesting(false)}
              style={{ fontSize: 11 }}
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* ── Chat about it panel ── */}
      {chatOpen && (
        <div className="routine-card__body" style={{ paddingTop: 4 }}>
          <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-muted)', marginBottom: 6 }}>
            Chat about it
          </div>
          <ChatThread
            messages={chatThread}
            streaming={chatStreaming}
            streamingContent={chatStreamContent}
            onSend={handleChatSend}
            onStop={handleChatStop}
            error={chatError}
            sendDisabled={chatStreaming}
          />
          <div style={{ marginTop: 6, display: 'flex', justifyContent: 'flex-end' }}>
            <button
              className="btn btn--ghost"
              onClick={() => setChatOpen(false)}
              style={{ fontSize: 11 }}
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* ── Challenge input ── */}
      {challenging && !isTerminal && (
        <div className="routine-card__body" style={{ paddingTop: 4 }}>
          <textarea
            ref={challengeRef}
            className="review-field__input"
            placeholder="Why isn't this right? This teaches the agent."
            value={challengeReason}
            onChange={(e) => setChallengeReason(e.target.value)}
            rows={1}
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
      {!isTerminal && !challenging && !suggesting && (
        <div className="routine-card__body" style={{ paddingTop: 10, display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          {isObservation ? (
            <>
              <button
                className="btn btn--ghost"
                onClick={(e) => { e.stopPropagation(); setChatOpen((o) => !o) }}
                disabled={loading}
                style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}
                title="Chat with Claude about this insight"
              >
                <MessagesSquare size={11} />
                Chat
              </button>
              <button
                className="btn btn--ghost"
                onClick={(e) => { e.stopPropagation(); setChallenging(true) }}
                disabled={loading}
                style={{ fontSize: 11 }}
              >
                Correct it
              </button>
              <button
                className="btn btn--ghost"
                onClick={(e) => { e.stopPropagation(); handleDismiss() }}
                disabled={loading}
                style={{ fontSize: 11 }}
              >
                Got it
              </button>
            </>
          ) : (
            <>
              <button
                className="btn btn--ghost"
                onClick={(e) => { e.stopPropagation(); handleDismiss() }}
                disabled={loading}
                style={{ fontSize: 11 }}
              >
                Dismiss
              </button>
              <button
                className="btn btn--ghost"
                onClick={(e) => { e.stopPropagation(); setChatOpen((o) => !o) }}
                disabled={loading}
                style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}
                title="Chat with Claude about this insight"
              >
                <MessagesSquare size={11} />
                Chat
              </button>
              <button
                className="btn btn--ghost"
                onClick={(e) => { e.stopPropagation(); setSuggesting(true); setExpanded(true) }}
                disabled={loading}
                style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}
                title="Ask mypa to rethink this proposal"
              >
                <Lightbulb size={11} />
                Suggest
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
                  disabled={loading || (!!payloadDraftKey && !draftText.trim())}
                  style={{ fontSize: 11 }}
                >
                  {payloadDraftKey ? 'Send' : 'Approve'}
                </button>
              )}
            </>
          )}
        </div>
      )}

      {/* ── Chat button for terminal intents (always available for recovery/discussion) ── */}
      {isTerminal && !chatOpen && (
        <div className="routine-card__body" style={{ paddingTop: 4, display: 'flex', justifyContent: 'flex-end' }}>
          <button
            className="btn btn--ghost"
            onClick={(e) => { e.stopPropagation(); setChatOpen(true) }}
            style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}
            title="Chat with Claude about this insight"
          >
            <MessagesSquare size={11} />
            Chat about it
          </button>
        </div>
      )}
    </div>
  )
}
