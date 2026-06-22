import React, { useState, useEffect, useRef } from 'react'
import { ChevronDown, Settings, ExternalLink, GitBranch, SquareKanban, MessageSquare } from 'lucide-react'
import ChatThread from './ChatThread'
import type { RoutineRun, ChatMessage, CoveredEntity, Intent, PendingToolApproval, PendingQuestion } from '../../../../../../shared/types'

interface Props {
  run: RoutineRun
  onRunChange: (run: RoutineRun) => void
  collapsed?: boolean
  /** Maps a work-item key to the most-recent intent for that entity (from App-level state). */
  entityKeyToIntent?: Map<string, Intent>
}

function EntityIcon({ surface }: { surface: string }): React.ReactElement {
  const size = 11
  if (surface === 'github') return <GitBranch size={size} strokeWidth={2} />
  if (surface === 'jira') return <SquareKanban size={size} strokeWidth={2} />
  return <MessageSquare size={size} strokeWidth={2} />
}

function entityStatusLabel(intent: Intent | undefined): { label: string; color: string } {
  if (!intent) return { label: 'Tracked', color: 'var(--text-muted)' }
  const s = intent.status
  if (s === 'executed' || s === 'approved') return { label: 'Handled', color: 'var(--green)' }
  if (s === 'dismissed' || s === 'challenged') return { label: 'Dismissed', color: 'var(--text-muted)' }
  if (s === 'expired' || s === 'failed') return { label: 'Expired', color: 'var(--text-muted)' }
  // pending / surfaced — live insight
  return { label: 'Insight active', color: 'var(--accent)' }
}

function parseDigest(digest: string | null): { summary: string; body: string } | null {
  if (!digest) return null
  try { return JSON.parse(digest) } catch { return null }
}

function formatTime(ts: string): string {
  const d = new Date(ts)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export default function RoutineCard({ run, onRunChange, collapsed, entityKeyToIntent }: Props): React.ReactElement {
  const [expanded, setExpanded] = useState(!collapsed && (run.status === 'pending_response' || run.status === 'in_progress'))
  const [thread, setThread] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState(false)
  const [streamContent, setStreamContent] = useState('')
  const [chatError, setChatError] = useState<string | null>(null)
  const [pendingToolApproval, setPendingToolApproval] = useState<PendingToolApproval | null>(null)
  const [pendingQuestion, setPendingQuestion] = useState<PendingQuestion | null>(null)

  const api = window.electron
  const digest = parseDigest(run.digest)
  // Ref so the message handler always sees the latest run without re-subscribing
  const runRef = useRef(run)
  useEffect(() => { runRef.current = run }, [run])

  useEffect(() => {
    if (!expanded) return
    api.routines.getThread(run.id).then(setThread)
  }, [expanded, run.id])

  useEffect(() => {
    const unsubMsg = api.on('routine:user-message', (payload) => {
      const p = payload as { runId: string; message: ChatMessage }
      if (p.runId !== run.id) return
      setThread((prev) => [...prev, p.message])
      setStreaming(true)
    })
    const unsubStream = api.on('routine:run-message', (payload) => {
      const p = payload as { runId: string; chunk: string; done: boolean; error?: string }
      if (p.runId !== run.id) return
      if (p.done) {
        setPendingToolApproval(null)
        setPendingQuestion(null)
        setStreaming(false)
        setStreamContent('')
        if (p.error) {
          setChatError(p.error)
        } else {
          api.routines.getThread(run.id).then(setThread)
          // Use the ref to avoid clobbering a dismissed/resolved status
          const current = runRef.current
          if (current.status === 'pending_response' || current.status === 'in_progress') {
            onRunChange({ ...current, status: 'in_progress' })
          }
        }
      } else {
        setStreaming(true)
        setStreamContent((prev) => prev + p.chunk)
      }
    })
    return () => { unsubMsg(); unsubStream() }
  }, [run.id])

  useEffect(() => {
    const unsub = api.on('chat:tool-approval-request', (payload) => {
      const p = payload as PendingToolApproval
      if (p.streamId !== run.id) return
      setPendingToolApproval(p)
    })
    return unsub
  }, [run.id])

  useEffect(() => {
    const unsub = api.on('chat:ask-question', (payload) => {
      const p = payload as PendingQuestion
      if (p.streamId !== run.id) return
      setPendingQuestion(p)
    })
    return unsub
  }, [run.id])

  const handleSend = async (msg: string) => {
    setChatError(null)
    setStreamContent('')
    await api.routines.sendMessage(run.id, msg)
  }

  const handleStop = async () => {
    await api.routines.cancelStream(run.id)
    setStreaming(false)
    setStreamContent('')
  }

  const handleDismiss = async () => {
    await api.routines.updateRunStatus(run.id, 'dismissed')
    onRunChange({ ...run, status: 'dismissed' })
    setExpanded(false)
  }

  const dotClass = `routine-card__dot routine-card__dot--${
    run.status === 'running'
      ? 'running'
      : run.status === 'pending_response' || run.status === 'in_progress'
      ? 'pending'
      : run.status === 'resolved'
      ? 'resolved'
      : run.status === 'error'
      ? 'error'
      : 'dismissed'
  }`

  const cardClass = `routine-card${
    run.status === 'pending_response' ? ' routine-card--pending' : ''
  }${run.status === 'error' ? ' routine-card--error' : ''}${
    run.status === 'resolved' || run.status === 'dismissed' ? ' routine-card--resolved' : ''
  }`

  return (
    <div className={cardClass}>
      <div
        className="routine-card__header"
        onClick={() => !collapsed && setExpanded((e) => !e)}
        style={collapsed ? { cursor: 'default' } : undefined}
      >
        <span className={dotClass} />
        <div className="routine-card__meta">
          <div className="routine-card__name">{run.routine_name}</div>
          {digest && (
            <div className="routine-card__summary">{digest.summary}</div>
          )}
          {run.status === 'running' && (
            <div className="routine-card__summary">Running…</div>
          )}
          {run.status === 'error' && run.error && (
            <div className="routine-card__summary" style={{ color: 'var(--red)' }}>
              Error: {run.error}
            </div>
          )}
        </div>
        <span className="routine-card__time">{formatTime(run.started_at)}</span>
        <button
          className="routine-card__cog-btn"
          onClick={(e) => { e.stopPropagation(); window.electron.system.openMainWindow(run.routine_id) }}
          title="Edit routine"
        >
          <Settings size={11} />
        </button>
        {!collapsed && (
          <span className={`routine-card__expand-icon${expanded ? ' open' : ''}`}><ChevronDown size={12} /></span>
        )}
      </div>

      {!collapsed && expanded && (
        <div className="routine-card__body">
          {/* Tracked items — work items detected in the run's MCP output */}
          {run.covered_entities && run.covered_entities.length > 0 && (
            <div className="routine-card__tracked">
              <div className="routine-card__tracked-label">Tracked items</div>
              {run.covered_entities.map((entity: CoveredEntity) => {
                const intent = entityKeyToIntent?.get(entity.key)
                const { label: statusLabel, color: statusColor } = entityStatusLabel(intent)
                return (
                  <div key={entity.key} className="routine-card__tracked-row">
                    <span className="routine-card__tracked-icon">
                      <EntityIcon surface={entity.surface} />
                    </span>
                    <span className="routine-card__tracked-title" title={entity.url || undefined}>
                      {entity.title || entity.external_id}
                    </span>
                    <span className="routine-card__tracked-status" style={{ color: statusColor }}>
                      {statusLabel}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
          <ChatThread
            messages={thread}
            streaming={streaming}
            streamingContent={streamContent}
            onSend={handleSend}
            onStop={handleStop}
            sendDisabled={streaming || run.status === 'running'}
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

          <div style={{ marginTop: 8, display: 'flex', gap: 6, alignItems: 'center' }}>
            <button
              className="btn btn--ghost"
              style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4, marginRight: 'auto' }}
              onClick={() => window.electron.routines.openRunInMainWindow(run.id)}
              title="Open full chat in main window"
            >
              <ExternalLink size={11} />
              Open in main window
            </button>
            {run.status !== 'dismissed' && run.status !== 'resolved' && (
              <button className="btn btn--ghost" onClick={handleDismiss} style={{ fontSize: 11 }}>
                Dismiss
              </button>
            )}
            {(run.status === 'in_progress' || run.status === 'pending_response') && (
              <button
                className="btn btn--primary"
                onClick={async () => {
                  await api.routines.updateRunStatus(run.id, 'resolved')
                  onRunChange({ ...run, status: 'resolved' })
                  setExpanded(false)
                }}
                style={{ fontSize: 11 }}
              >
                Mark resolved
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
