import React from 'react'
import { Inbox, Zap, List } from 'lucide-react'
import Tabs from '@renderer/components/Tabs'
import type { TabItem } from '@renderer/components/Tabs'
import RoutinesManager from './RoutinesManager'
import RunLogs from './RunLogs'

export type RoutinesTab = 'needs' | 'routines' | 'logs'

interface Props {
  editRoutineId?: string | null
  onEditHandled?: () => void
  initialRunId?: string | null
  onInitialRunHandled?: () => void
  tab: RoutinesTab
  onTabChange: (t: RoutinesTab) => void
  pendingCount: number
}

export default function RoutinesPage({
  editRoutineId,
  onEditHandled,
  initialRunId,
  onInitialRunHandled,
  tab,
  onTabChange,
  pendingCount,
}: Props): React.ReactElement {
  const TABS: TabItem[] = [
    { id: 'needs', label: 'Needs you', icon: <Inbox size={13} strokeWidth={2} />, count: pendingCount },
    { id: 'routines', label: 'Routines', icon: <Zap size={13} strokeWidth={2} /> },
    { id: 'logs', label: 'Run Logs', icon: <List size={13} strokeWidth={2} /> },
  ]

  const subtitle =
    tab === 'needs'
      ? 'Routine runs waiting for your response'
      : tab === 'routines'
        ? 'Scheduled jobs that check your tools and notify you'
        : 'History of all routine executions'

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Routines</h1>
        <p className="page-subtitle">{subtitle}</p>
      </div>
      <Tabs items={TABS} active={tab} onChange={(id) => onTabChange(id as RoutinesTab)} />
      {tab === 'needs' && (
        <RunLogs
          filterStatuses={['pending_response', 'in_progress']}
          emptyMessage="Nothing needs your response right now."
          initialRunId={initialRunId}
          onInitialRunHandled={onInitialRunHandled}
        />
      )}
      {tab === 'routines' && (
        <RoutinesManager editRoutineId={editRoutineId} onEditHandled={onEditHandled} />
      )}
      {tab === 'logs' && (
        <RunLogs initialRunId={initialRunId} onInitialRunHandled={onInitialRunHandled} />
      )}
    </div>
  )
}
