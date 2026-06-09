import React, { useState, useEffect, useRef } from 'react'
import ChatThread from '../../widget/components/ChatThread'
import type { RoutineRun, ChatMessage } from '../../../../../../shared/types'

function formatTs(ts: string): string {
  return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function parseDigest(digest: string | null): string {
  if (!digest) return ''
  try {
    const d = JSON.parse(digest)
    return d.summary ?? ''
  } catch {
    return ''
  }
}

type RunView = 'output' | 'chat'

interface RunDetailProps {
  run: RoutineRun
  defaultView?: RunView
}

function RunDetail({ run, defaultView = 'output' }: RunDetailProps): React.ReactElement {
  const [view, setView] = useState<RunView>(defaultView)
  const [thread, setThread] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState(false)
  const [streamContent, setStreamContent] = useState('')
  const [chatError, setChatError] = useState<string | null>(null)
  const api = window.electron

  useEffect(() => {
    if (view === 'chat') {
      api.routines.getThread(run.id).then(setThread)
    }
  }, [view, run.id])

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
        setStreaming(false)
        setStreamContent('')
        if (p.error) {
          setChatError(p.error)
        } else {
          api.routines.getThread(run.id).then(setThread)
        }
      } else {
        setStreaming(true)
        setStreamContent((prev) => prev + p.chunk)
      }
    })
    return () => { unsubMsg(); unsubStream() }
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

  return (
    <div style={{ background: 'var(--bg-elevated)', borderTop: '1px solid var(--border-muted)', padding: '12px 16px' }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        <button
          className={`btn ${view === 'output' ? 'btn--primary' : 'btn--ghost'}`}
          style={{ fontSize: 11, padding: '3px 10px' }}
          onClick={() => setView('output')}
        >
          Raw output
        </button>
        <button
          className={`btn ${view === 'chat' ? 'btn--primary' : 'btn--ghost'}`}
          style={{ fontSize: 11, padding: '3px 10px' }}
          onClick={() => setView('chat')}
        >
          Conversation
        </button>
      </div>

      {view === 'output' ? (
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--text-secondary)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: 400,
            overflowY: 'auto'
          }}
        >
          {run.raw_output ?? 'No raw output'}
        </div>
      ) : (
        <ChatThread
          messages={thread}
          streaming={streaming}
          streamingContent={streamContent}
          onSend={handleSend}
          onStop={handleStop}
          sendDisabled={streaming || run.status === 'running'}
          error={chatError}
        />
      )}
    </div>
  )
}

interface Props {
  initialRunId?: string | null
  onInitialRunHandled?: () => void
}

export default function RunLogs({ initialRunId, onInitialRunHandled }: Props): React.ReactElement {
  const [runs, setRuns] = useState<RoutineRun[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [chatRunId, setChatRunId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const expandedRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    window.electron.routines.getAllRuns(50).then((r) => {
      setRuns(r)
      setLoading(false)
    })
  }, [])

  // Handle navigate:run-chat — auto-expand the target run in chat view
  useEffect(() => {
    if (initialRunId && !loading) {
      setExpanded(initialRunId)
      setChatRunId(initialRunId)
      onInitialRunHandled?.()
      // Scroll into view after a brief render delay
      setTimeout(() => expandedRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100)
    }
  }, [initialRunId, loading])

  const handleExpand = (run: RoutineRun) => {
    if (expanded === run.id) {
      setExpanded(null)
      setChatRunId(null)
    } else {
      setExpanded(run.id)
      setChatRunId(null)
    }
  }

  return (
    <div>
      {loading ? (
        <div style={{ padding: 24, color: 'var(--text-muted)' }}>Loading…</div>
      ) : runs.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text-muted)' }}>
          No runs yet. Routines will appear here once they execute.
        </div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          {runs.map((run) => (
            <div key={run.id} ref={expanded === run.id ? expandedRef : undefined}>
              <div className="run-log-row" style={{ cursor: 'pointer' }} onClick={() => handleExpand(run)}>
                <div className={`run-log-row__status-dot run-log-row__status-dot--${run.status}`} />
                <div className="run-log-row__name">{run.routine_name}</div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', flex: 2 }}>
                  {parseDigest(run.digest) || '—'}
                </div>
                <span className="run-log-row__time">{formatTs(run.started_at)}</span>
                <span className="tag tag--neutral" style={{ marginLeft: 8 }}>{run.status}</span>
                <span style={{ color: 'var(--text-muted)', fontSize: 12, marginLeft: 8 }}>
                  {expanded === run.id ? '▴' : '▾'}
                </span>
              </div>

              {expanded === run.id && (
                <RunDetail
                  run={run}
                  defaultView={chatRunId === run.id ? 'chat' : 'output'}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
