import React, { Fragment } from 'react'
import { Zap, Settings } from 'lucide-react'
import RoutineCard from './RoutineCard'
import type { RoutineRun } from '../../../../../../shared/types'

interface Props {
  runs: RoutineRun[]
  onRunsChange: (runs: RoutineRun[]) => void
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

function dateLabel(ts: string): string {
  const d = new Date(ts)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (isSameDay(d, today)) return 'Today'
  if (isSameDay(d, yesterday)) return 'Yesterday'
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export default function RoutinesFeed({ runs, onRunsChange }: Props): React.ReactElement {
  if (runs.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state__icon"><Zap size={24} strokeWidth={1.5} /></div>
        <h3>No routine runs yet</h3>
        <p>Set up a routine in settings and it will appear here when it runs.</p>
        <button
          className="empty-state__action"
          onClick={() => window.electron.system.openMainWindow()}
        >
          <Settings size={12} /> Open settings
        </button>
      </div>
    )
  }

  const handleRunChange = (updated: RoutineRun) => {
    onRunsChange(runs.map((r) => (r.id === updated.id ? updated : r)))
  }

  const needsAttention = runs.filter(
    (r) => r.status === 'pending_response' || r.status === 'running' || r.status === 'error'
  )
  const archived = runs.filter(
    (r) => r.status !== 'pending_response' && r.status !== 'running' && r.status !== 'error'
  )

  // Group archived by date label (preserving insertion order = newest first)
  const dateGroupMap = new Map<string, Map<string, RoutineRun[]>>()
  for (const run of archived) {
    const label = dateLabel(run.started_at)
    if (!dateGroupMap.has(label)) dateGroupMap.set(label, new Map())
    const byRoutine = dateGroupMap.get(label)!
    if (!byRoutine.has(run.routine_name)) byRoutine.set(run.routine_name, [])
    byRoutine.get(run.routine_name)!.push(run)
  }

  return (
    <div>
      {needsAttention.length > 0 && (
        <>
          <div className="section-header">Needs Attention</div>
          {needsAttention.map((run) => (
            <RoutineCard key={run.id} run={run} onRunChange={handleRunChange} />
          ))}
        </>
      )}

      {Array.from(dateGroupMap.entries()).map(([label, byRoutine]) => {
        const routineNames = Array.from(byRoutine.keys())
        const showSubheaders = routineNames.length > 1
        return (
          <Fragment key={label}>
            <div className="section-header">{label}</div>
            {routineNames.map((name) => (
              <Fragment key={name}>
                {showSubheaders && <div className="section-subheader">{name}</div>}
                {byRoutine.get(name)!.map((run) => (
                  <RoutineCard key={run.id} run={run} onRunChange={handleRunChange} collapsed />
                ))}
              </Fragment>
            ))}
          </Fragment>
        )
      })}
    </div>
  )
}
