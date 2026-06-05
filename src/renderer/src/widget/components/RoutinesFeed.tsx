import React from 'react'
import { Zap, Settings } from 'lucide-react'
import RoutineCard from './RoutineCard'
import type { RoutineRun } from '../../../../../../shared/types'

interface Props {
  runs: RoutineRun[]
  onRunsChange: (runs: RoutineRun[]) => void
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

  return (
    <div>
      {runs.map((run) => (
        <RoutineCard key={run.id} run={run} onRunChange={handleRunChange} />
      ))}
    </div>
  )
}
