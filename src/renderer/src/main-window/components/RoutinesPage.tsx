import React from 'react'
import { Zap, List } from 'lucide-react'
import Tabs from '@renderer/components/Tabs'
import type { TabItem } from '@renderer/components/Tabs'
import RoutinesManager from './RoutinesManager'
import RunLogs from './RunLogs'

interface Props {
  editRoutineId?: string | null
  onEditHandled?: () => void
  initialRunId?: string | null
  onInitialRunHandled?: () => void
  tab: 'routines' | 'logs'
  onTabChange: (t: 'routines' | 'logs') => void
}

const TABS: TabItem[] = [
  { id: 'routines', label: 'Routines', icon: <Zap size={13} strokeWidth={2} /> },
  { id: 'logs', label: 'Run Logs', icon: <List size={13} strokeWidth={2} /> },
]

export default function RoutinesPage({
  editRoutineId,
  onEditHandled,
  initialRunId,
  onInitialRunHandled,
  tab,
  onTabChange,
}: Props): React.ReactElement {
  const subtitle =
    tab === 'routines'
      ? 'Scheduled jobs that check your tools and notify you'
      : 'History of all routine executions'

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Routines</h1>
        <p className="page-subtitle">{subtitle}</p>
      </div>
      <Tabs items={TABS} active={tab} onChange={(id) => onTabChange(id as 'routines' | 'logs')} />
      {tab === 'routines' ? (
        <RoutinesManager editRoutineId={editRoutineId} onEditHandled={onEditHandled} />
      ) : (
        <RunLogs initialRunId={initialRunId} onInitialRunHandled={onInitialRunHandled} />
      )}
    </div>
  )
}
