import React, { Fragment } from 'react'
import { ClipboardList } from 'lucide-react'
import PlanItemCard from './PlanItemCard'
import type { PlanItem, PlanItemTiming } from '@shared/types'

const TIMING_ORDER: PlanItemTiming[] = ['now', 'morning', 'afternoon', 'evening', 'anytime']
const TIMING_LABELS: Record<PlanItemTiming, string> = {
  now: 'Now',
  morning: 'Morning',
  afternoon: 'Afternoon',
  evening: 'Evening',
  anytime: 'Anytime'
}

interface Props {
  items: PlanItem[]
  onStatusChange: (id: string, status: PlanItem['status']) => void
  onItemsChange: (items: PlanItem[]) => void
}

export default function PlanList({ items, onStatusChange, onItemsChange }: Props): React.ReactElement {
  const activeItems = items.filter((i) => i.status === 'pending' || i.status === 'in_progress')
  const doneItems = items.filter((i) => i.status === 'done' || i.status === 'skipped')

  if (activeItems.length === 0 && doneItems.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state__icon"><ClipboardList size={24} strokeWidth={1.5} /></div>
        <h3>No plan items yet</h3>
        <p>Use the bar below to add something you need to do today.</p>
      </div>
    )
  }

  const grouped: Partial<Record<PlanItemTiming, PlanItem[]>> = {}
  for (const item of activeItems) {
    if (!grouped[item.timing]) grouped[item.timing] = []
    grouped[item.timing]!.push(item)
  }

  const handleDelete = async (id: string) => {
    await window.electron.plan.delete(id)
    onItemsChange(items.filter((i) => i.id !== id))
  }

  return (
    <div>
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

      {doneItems.length > 0 && (
        <>
          <div className="section-header">Done / Skipped</div>
          {doneItems.map((item) => (
            <PlanItemCard
              key={item.id}
              item={item}
              onStatusChange={onStatusChange}
              onDelete={handleDelete}
              collapsed
            />
          ))}
        </>
      )}
    </div>
  )
}
