import React, { useState, useEffect } from 'react'
import type { RoutineRun } from '../../../../../../shared/types'


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

export default function RunLogs(): React.ReactElement {
  const [runs, setRuns] = useState<RoutineRun[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [raw, setRaw] = useState<string>('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    window.electron.routines.getAllRuns(50).then((r) => { setRuns(r); setLoading(false) })
  }, [])

  const handleExpand = async (run: RoutineRun) => {
    if (expanded === run.id) {
      setExpanded(null)
      return
    }
    setExpanded(run.id)
    setRaw(run.raw_output ?? 'No raw output')
  }

  return (
    <div>
      <div className="page-header">
        <div className="page-title">Run Logs</div>
        <div className="page-subtitle">History of all routine executions</div>
      </div>

      {loading ? (
        <div style={{ padding: 24, color: 'var(--text-muted)' }}>Loading…</div>
      ) : runs.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text-muted)' }}>
          No runs yet. Routines will appear here once they execute.
        </div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          {runs.map((run) => (
            <div key={run.id}>
              <div className="run-log-row" style={{ cursor: 'pointer' }} onClick={() => handleExpand(run)}>
                <div
                  className={`run-log-row__status-dot run-log-row__status-dot--${run.status}`}
                />
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
                <div
                  style={{
                    background: 'var(--bg-elevated)',
                    borderTop: '1px solid var(--border-muted)',
                    padding: '12px 16px',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    color: 'var(--text-secondary)',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    maxHeight: 300,
                    overflowY: 'auto'
                  }}
                >
                  {raw}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
