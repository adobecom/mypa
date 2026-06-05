import React, { useState, useEffect } from 'react'
import { ChevronDown, Settings } from 'lucide-react'
import ChatThread from './ChatThread'
import type { RoutineRun, ChatMessage } from '../../../../../../shared/types'

interface Props {
  run: RoutineRun
  onRunChange: (run: RoutineRun) => void
  collapsed?: boolean
}

function parseDigest(digest: string | null): { summary: string; items: string[]; proposed_actions: string[] } | null {
  if (!digest) return null
  try { return JSON.parse(digest) } catch { return null }
}

function formatTime(ts: string): string {
  const d = new Date(ts)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export default function RoutineCard({ run, onRunChange, collapsed }: Props): React.ReactElement {
  const [expanded, setExpanded] = useState(!collapsed && run.status === 'pending_response')
  const [thread, setThread] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState(false)
  const [streamContent, setStreamContent] = useState('')
  const [chatError, setChatError] = useState<string | null>(null)

  const api = window.electron
  const digest = parseDigest(run.digest)

  useEffect(() => {
    if (!expanded) return
    api.routines.getThread(run.id).then(setThread)
  }, [expanded, run.id])

  useEffect(() => {
    const unsub = api.on('routine:run-message', (payload) => {
      const p = payload as { runId: string; chunk: string; done: boolean; error?: string }
      if (p.runId !== run.id) return
      if (p.done) {
        setStreaming(false)
        setStreamContent('')
        if (p.error) {
          setChatError(p.error)
        } else {
          api.routines.getThread(run.id).then(setThread)
          onRunChange({ ...run, status: 'in_progress' })
        }
      } else {
        setStreaming(true)
        setStreamContent((prev) => prev + p.chunk)
      }
    })
    return unsub
  }, [run.id])

  const handleSend = async (msg: string) => {
    setChatError(null)
    setStreaming(true)
    setStreamContent('')
    setThread((prev) => [
      ...prev,
      { id: Date.now().toString(), role: 'user', content: msg, timestamp: new Date().toISOString() }
    ])
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
          {digest && digest.items.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              {digest.items.map((item, i) => (
                <div key={i} style={{ fontSize: 12, color: 'var(--text-secondary)', padding: '2px 0' }}>
                  • {item}
                </div>
              ))}
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
          />

          <div style={{ marginTop: 8, display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
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
