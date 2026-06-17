import React, { Fragment } from 'react'
import { Inbox } from 'lucide-react'
import IntentCard from './IntentCard'
import PlanItemCard from './PlanItemCard'
import type { Intent, PlanItem, PlanItemTiming, RoutineRun } from '../../../../../../shared/types'

const TERMINAL: Intent['status'][] = ['executed', 'dismissed', 'challenged', 'failed', 'expired']
const TIMING_ORDER: PlanItemTiming[] = ['now', 'morning', 'afternoon', 'evening', 'anytime']
const TIMING_LABELS: Record<PlanItemTiming, string> = {
  now: 'Now',
  morning: 'Morning',
  afternoon: 'Afternoon',
  evening: 'Evening',
  anytime: 'Anytime'
}

interface Props {
  intents: Intent[]
  onIntentsChange: (intents: Intent[]) => void
  items: PlanItem[]
  onStatusChange: (id: string, status: PlanItem['status']) => void
  onItemsChange: (items: PlanItem[]) => void
  /** Maps a work-item key to the list of routine runs that cover it. */
  entityKeyToRuns?: Map<string, RoutineRun[]>
}

export default function QueueView({
  intents,
  onIntentsChange,
  items,
  onStatusChange,
  onItemsChange,
  entityKeyToRuns
}: Props): React.ReactElement {
  // "Needs you" — pending actionable intents awaiting approval
  const pendingIntents = intents.filter(
    (i) => i.type === 'action' && !TERMINAL.includes(i.status)
  )

  // "Recently resolved" — terminal intents present in this session's state, newest first, capped at 5.
  // These are intents that were pending when the widget opened and became terminal since then
  // (executed, dismissed, expired, etc.). Shows where items went rather than silently disappearing.
  const recentlyResolved = intents
    .filter((i) => TERMINAL.includes(i.status))
    .sort((a, b) => {
      const ta = a.resolved_at ?? a.created_at
      const tb = b.resolved_at ?? b.created_at
      return new Date(tb).getTime() - new Date(ta).getTime()
    })
    .slice(0, 5)

  // "Tasks" — active plan items
  const activeItems = items.filter((i) => i.status === 'pending' || i.status === 'in_progress')

  // "Done" — completed plan items newest-first (includes agent-executed ambient_action records).
  // getAll() returns items ORDER BY created_at ASC so we sort before slicing.
  const doneItems = items
    .filter((i) => i.status === 'done' || i.status === 'skipped')
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 10)

  const isEmpty = pendingIntents.length === 0 && activeItems.length === 0 && doneItems.length === 0 && recentlyResolved.length === 0

  function handleIntentChange(updated: Intent): void {
    onIntentsChange(intents.map((i) => (i.id === updated.id ? updated : i)))
  }

  async function handleDelete(id: string): Promise<void> {
    await window.electron.plan.delete(id)
    onItemsChange(items.filter((i) => i.id !== id))
  }

  if (isEmpty) {
    return (
      <div className="empty-state">
        <div className="empty-state__icon">
          <Inbox size={24} strokeWidth={1.5} />
        </div>
        <h3>Queue is clear</h3>
        <p>No actions pending. Add a task below or wait for the agent to surface one.</p>
      </div>
    )
  }

  const grouped: Partial<Record<PlanItemTiming, PlanItem[]>> = {}
  for (const item of activeItems) {
    if (!grouped[item.timing]) grouped[item.timing] = []
    grouped[item.timing]!.push(item)
  }

  const needsApproval = pendingIntents.some((i) => i.required_approval && i.tier >= 2)

  return (
    <div>
      {pendingIntents.length > 0 && (
        <>
          <div
            className="section-header"
            style={needsApproval ? { color: 'var(--accent)' } : undefined}
          >
            Needs you
          </div>
          {pendingIntents.map((intent) => (
            <IntentCard key={intent.id} intent={intent} onIntentChange={handleIntentChange} entityKeyToRuns={entityKeyToRuns} />
          ))}
        </>
      )}

      {activeItems.length > 0 && (
        <>
          {TIMING_ORDER.filter((t) => grouped[t]?.length).map((timing) => (
            <Fragment key={timing}>
              <div className="section-header">{TIMING_LABELS[timing]}</div>
              {grouped[timing]!.map((item) => (
                <PlanItemCard
                  key={item.id}
                  item={item}
                  onStatusChange={onStatusChange}
                  onDelete={handleDelete}
                />
              ))}
            </Fragment>
          ))}
        </>
      )}

      {doneItems.length > 0 && (
        <>
          <div className="section-header" style={{ color: 'var(--text-muted)' }}>
            Done
          </div>
          {doneItems.map((item) => (
            <PlanItemCard
              key={item.id}
              item={item}
              onStatusChange={onStatusChange}
              onDelete={handleDelete}
              collapsed
              readOnly={item.source === 'ambient_action'}
            />
          ))}
        </>
      )}

      {recentlyResolved.length > 0 && (
        <>
          <div className="section-header" style={{ color: 'var(--text-muted)' }}>
            Recently resolved
          </div>
          {recentlyResolved.map((intent) => (
            <IntentCard key={intent.id} intent={intent} onIntentChange={handleIntentChange} entityKeyToRuns={entityKeyToRuns} />
          ))}
        </>
      )}
    </div>
  )
}
