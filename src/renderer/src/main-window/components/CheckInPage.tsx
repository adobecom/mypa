import React, { useState, useEffect, useRef } from 'react'
import { CheckCircle, Loader2, AlertCircle, MessageSquare } from 'lucide-react'
import ChatThread from '../../widget/components/ChatThread'
import type { CheckIn, ChatMessage, CheckInExtractionSummary, PendingToolApproval, PendingQuestion } from '@shared/types'

function formatTs(ts: string): string {
  return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function parseExtractionSummary(raw: string | null): CheckInExtractionSummary | null {
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

interface CheckInDetailProps {
  checkin: CheckIn
  onCheckinUpdated: (ci: CheckIn) => void
}

function CheckInDetail({ checkin, onCheckinUpdated }: CheckInDetailProps): React.ReactElement {
  const [thread, setThread] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState(false)
  const [streamContent, setStreamContent] = useState('')
  const [chatError, setChatError] = useState<string | null>(null)
  const [pendingToolApproval, setPendingToolApproval] = useState<PendingToolApproval | null>(null)
  const [pendingQuestion, setPendingQuestion] = useState<PendingQuestion | null>(null)
  const [current, setCurrent] = useState<CheckIn>(checkin)
  const api = window.electron

  useEffect(() => {
    setCurrent(checkin)
    api.checkin.getThread(checkin.id).then(setThread)
  }, [checkin.id])

  useEffect(() => {
    const unsubMsg = api.on('checkin:message', (payload) => {
      const p = payload as { checkinId: string; chunk: string; done: boolean; error?: string }
      if (p.checkinId !== current.id) return
      if (p.done) {
        setPendingToolApproval(null)
        setPendingQuestion(null)
        setStreaming(false)
        setStreamContent('')
        if (p.error) {
          setChatError(p.error)
        } else {
          api.checkin.getThread(current.id).then(setThread)
        }
      } else {
        setStreaming(true)
        setStreamContent((prev) => prev + p.chunk)
      }
    })

    const unsubStatus = api.on('checkin:status-changed', (payload) => {
      const ci = payload as CheckIn
      if (ci.id !== current.id) return
      setCurrent(ci)
      onCheckinUpdated(ci)
    })

    return () => {
      unsubMsg()
      unsubStatus()
    }
  }, [current.id])

  useEffect(() => {
    const unsub = api.on('chat:tool-approval-request', (payload) => {
      const p = payload as PendingToolApproval
      if (p.streamId !== current.id) return
      setPendingToolApproval(p)
    })
    return unsub
  }, [current.id])

  useEffect(() => {
    const unsub = api.on('chat:ask-question', (payload) => {
      const p = payload as PendingQuestion
      if (p.streamId !== current.id) return
      setPendingQuestion(p)
    })
    return unsub
  }, [current.id])

  const handleSend = async (msg: string): Promise<void> => {
    setChatError(null)
    setStreaming(true)
    setStreamContent('')
    const optimisticId = Date.now().toString()
    setThread((prev) => [
      ...prev,
      { id: optimisticId, role: 'user', content: msg, timestamp: new Date().toISOString() }
    ])
    try {
      await api.checkin.sendMessage(current.id, msg)
    } catch (err: any) {
      setStreaming(false)
      setStreamContent('')
      setChatError(err?.message ?? 'Failed to send message')
      setThread((prev) => prev.filter((m) => m.id !== optimisticId))
    }
  }

  const handleStop = async (): Promise<void> => {
    await api.checkin.cancelStream(current.id)
    setStreaming(false)
    setStreamContent('')
  }

  const handleEnd = async (): Promise<void> => {
    await api.checkin.end(current.id)
  }

  const isActive = current.status === 'active'
  const isExtracting = current.status === 'extracting'
  const isComplete = current.status === 'complete'
  const isError = current.status === 'error'
  const isDismissed = current.status === 'dismissed'

  const extractionSummary = parseExtractionSummary(current.extraction_summary)

  return (
    <div style={{ background: 'var(--bg-elevated)', borderTop: '1px solid var(--border-muted)', padding: '12px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {formatTs(current.started_at)}
          {current.completed_at && ` — ${formatTs(current.completed_at)}`}
        </span>
        {isActive && (
          <button
            className="btn btn--ghost"
            style={{ fontSize: 11, padding: '3px 10px' }}
            onClick={handleEnd}
            disabled={streaming}
          >
            End check-in
          </button>
        )}
      </div>

      {isExtracting && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 0', color: 'var(--text-muted)', fontSize: 13 }}>
          <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
          Extracting knowledge from our conversation...
        </div>
      )}

      {isComplete && extractionSummary && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 12px', marginBottom: 12,
          background: 'var(--bg-base)', borderRadius: 6,
          border: '1px solid var(--border-muted)', fontSize: 12
        }}>
          <CheckCircle size={13} style={{ color: 'var(--color-success, #22c55e)', flexShrink: 0 }} />
          <span style={{ color: 'var(--text-secondary)' }}>
            Session complete —{' '}
            <strong>{extractionSummary.memoriesAdded}</strong> {extractionSummary.memoriesAdded === 1 ? 'memory' : 'memories'} added
            {extractionSummary.nodesUpdated > 0 && <> · <strong>{extractionSummary.nodesUpdated}</strong> nodes updated</>}
            {extractionSummary.edgesAdded > 0 && <> · <strong>{extractionSummary.edgesAdded}</strong> edges added</>}
            {extractionSummary.scopeUpdated > 0 && <> · scope updated (+<strong>{extractionSummary.scopeUpdated}</strong>)</>}
          </span>
        </div>
      )}

      {isError && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', color: 'var(--text-muted)', fontSize: 12 }}>
          <AlertCircle size={13} />
          Knowledge extraction failed — session saved but no updates were applied.
        </div>
      )}

      {isDismissed && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', color: 'var(--text-muted)', fontSize: 12 }}>
          <AlertCircle size={13} />
          Superseded by a newer check-in — this session was never started.
        </div>
      )}

      <ChatThread
        messages={thread}
        streaming={streaming}
        streamingContent={streamContent}
        onSend={handleSend}
        onStop={handleStop}
        sendDisabled={streaming || isExtracting || isComplete || isError || isDismissed}
        error={chatError}
        pendingToolApproval={pendingToolApproval}
        onApproveToolUse={async (editedInput) => {
          if (!pendingToolApproval) return
          await api.chat.resolveToolApproval(pendingToolApproval.approvalId, true, editedInput)
          setPendingToolApproval(null)
        }}
        onDenyToolUse={async () => {
          if (!pendingToolApproval) return
          await api.chat.resolveToolApproval(pendingToolApproval.approvalId, false)
          setPendingToolApproval(null)
        }}
        pendingQuestion={pendingQuestion}
        onAnswerQuestion={async (answer) => {
          if (!pendingQuestion) return
          await api.chat.answerQuestion(pendingQuestion.questionId, answer)
          setPendingQuestion(null)
        }}
      />
    </div>
  )
}

interface Props {
  activeCheckinId?: string | null
  onCheckinHandled?: () => void
}

export default function CheckInPage({ activeCheckinId, onCheckinHandled }: Props): React.ReactElement {
  const [checkins, setCheckins] = useState<CheckIn[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [starting, setStarting] = useState(false)
  const expandedRef = useRef<HTMLDivElement | null>(null)
  const api = window.electron

  useEffect(() => {
    api.checkin.getAll().then((list) => {
      setCheckins(list)
      setLoading(false)
    })
  }, [])

  // Handle navigate:checkin — auto-expand the target
  useEffect(() => {
    if (activeCheckinId && !loading) {
      setExpanded(activeCheckinId)
      onCheckinHandled?.()
      setTimeout(() => expandedRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100)
    }
  }, [activeCheckinId, loading])

  // Listen for new check-ins started from outside (e.g., scheduled)
  useEffect(() => {
    const unsub = api.on('checkin:started', (payload) => {
      const ci = payload as CheckIn
      setCheckins((prev) => [ci, ...prev.filter((c) => c.id !== ci.id)])
      setExpanded(ci.id)
    })
    return unsub
  }, [])

  // Keep the list row in sync when a check-in's status changes elsewhere — in particular,
  // when a newer check-in supersedes an old undealt-with one that isn't currently expanded
  // (so CheckInDetail's own listener never mounts to catch the update).
  useEffect(() => {
    const unsub = api.on('checkin:status-changed', (payload) => handleCheckinUpdated(payload as CheckIn))
    return unsub
  }, [])

  const handleStart = async (): Promise<void> => {
    setStarting(true)
    try {
      const ci = await api.checkin.start()
      setCheckins((prev) => [ci, ...prev.filter((c) => c.id !== ci.id)])
      setExpanded(ci.id)
    } finally {
      setStarting(false)
    }
  }

  const handleCheckinUpdated = (updated: CheckIn): void => {
    setCheckins((prev) => prev.map((c) => (c.id === updated.id ? updated : c)))
  }

  const hasActive = checkins.some((c) => c.status === 'active')

  return (
    <div>
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div className="page-title">Check-in</div>
            <div className="page-subtitle">Periodic 1:1 sessions to guide your PA's growth</div>
          </div>
          <button
            className="btn btn--primary"
            onClick={handleStart}
            disabled={hasActive || starting}
          >
            {starting ? 'Starting…' : 'Start check-in'}
          </button>
        </div>
      </div>

      {loading ? (
        <div style={{ padding: 24, color: 'var(--text-muted)' }}>Loading…</div>
      ) : checkins.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '32px 0' }}>
          <MessageSquare size={28} style={{ color: 'var(--text-muted)', margin: '0 auto 12px' }} />
          <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No check-ins yet.</div>
          <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
            Start one to have your PA brief you on what it has learned.
          </div>
        </div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          {checkins.map((ci) => (
            <div key={ci.id} ref={expanded === ci.id ? expandedRef : undefined}>
              <div
                className="run-log-row"
                style={{ cursor: 'pointer' }}
                onClick={() => setExpanded(expanded === ci.id ? null : ci.id)}
              >
                <StatusDot status={ci.status} />
                <div className="run-log-row__name">
                  {ci.trigger === 'scheduled' ? 'Scheduled check-in' : 'Check-in'}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', flex: 2 }}>
                  {ci.status === 'complete'
                    ? summaryLine(ci.extraction_summary)
                    : ci.status === 'active'
                    ? 'In progress'
                    : ci.status === 'extracting'
                    ? 'Extracting knowledge…'
                    : ci.status === 'error'
                    ? 'Extraction failed'
                    : ci.status === 'dismissed'
                    ? 'Superseded by a newer check-in'
                    : ''}
                </div>
                <span className="run-log-row__time">{formatTs(ci.started_at)}</span>
                <span className={`tag tag--${statusTagVariant(ci.status)}`} style={{ marginLeft: 8 }}>
                  {ci.status}
                </span>
                <span style={{ color: 'var(--text-muted)', fontSize: 12, marginLeft: 8 }}>
                  {expanded === ci.id ? '▴' : '▾'}
                </span>
              </div>

              {expanded === ci.id && (
                <CheckInDetail
                  checkin={ci}
                  onCheckinUpdated={handleCheckinUpdated}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function StatusDot({ status }: { status: CheckIn['status'] }): React.ReactElement {
  const color = status === 'active' ? 'var(--color-blue, #3b82f6)'
    : status === 'complete' ? 'var(--color-success, #22c55e)'
    : status === 'error' ? 'var(--color-error, #ef4444)'
    : 'var(--text-muted)'
  return (
    <div style={{
      width: 7, height: 7, borderRadius: '50%',
      background: color, flexShrink: 0,
      /* Center against 12px font · lh ~1.4 ≈ 16.8px: (16.8−7)/2 ≈ 5px */
      marginTop: 5,
      animation: status === 'active' ? 'pulse 2s ease-in-out infinite' : undefined
    }} />
  )
}

function statusTagVariant(status: CheckIn['status']): string {
  if (status === 'active') return 'blue'
  if (status === 'complete') return 'success'
  if (status === 'error') return 'error'
  return 'neutral'
}

function summaryLine(raw: string | null): string {
  const s = parseExtractionSummary(raw)
  if (!s) return ''
  const parts: string[] = []
  if (s.memoriesAdded > 0) parts.push(`${s.memoriesAdded} ${s.memoriesAdded === 1 ? 'memory' : 'memories'} added`)
  if (s.nodesUpdated > 0) parts.push(`${s.nodesUpdated} nodes updated`)
  if (s.edgesAdded > 0) parts.push(`${s.edgesAdded} edges added`)
  if (s.scopeUpdated > 0) parts.push(`scope +${s.scopeUpdated}`)
  return parts.join(' · ') || 'Complete'
}
