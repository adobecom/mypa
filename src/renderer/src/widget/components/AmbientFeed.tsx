import React from 'react'
import { Radar } from 'lucide-react'
import IntentCard from './IntentCard'
import type { Intent } from '../../../../../../shared/types'

interface Props {
  intents: Intent[]
  onIntentsChange: (intents: Intent[]) => void
}

const TERMINAL_STATUSES: Intent['status'][] = ['executed', 'dismissed', 'challenged', 'failed', 'expired']

export default function AmbientFeed({ intents, onIntentsChange }: Props): React.ReactElement {
  // Widget shows only actionable intents — informational (flag/digest/suggestion) live
  // in the main-window Activity page and should not pollute the action queue.
  const actionable = intents.filter((i) => i.type === 'action')
  const active = actionable.filter((i) => !TERMINAL_STATUSES.includes(i.status))
  const recent = actionable.filter((i) => TERMINAL_STATUSES.includes(i.status)).slice(0, 5)

  const needsApproval = active.some((i) => i.required_approval && i.tier >= 2)

  function handleChange(updated: Intent): void {
    onIntentsChange(intents.map((i) => (i.id === updated.id ? updated : i)))
  }

  if (actionable.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state__icon"><Radar size={28} strokeWidth={1.5} /></div>
        <h3>All clear</h3>
        <p>No actions pending. The agent is watching.</p>
      </div>
    )
  }

  return (
    <div>
      {active.length > 0 && (
        <>
          <div
            className="section-header"
            style={needsApproval ? { color: 'var(--accent)' } : undefined}
          >
            Pending
          </div>
          {active.map((intent) => (
            <IntentCard key={intent.id} intent={intent} onIntentChange={handleChange} />
          ))}
        </>
      )}

      {recent.length > 0 && (
        <>
          <div className="section-header" style={{ color: 'var(--text-muted)' }}>Recent</div>
          {recent.map((intent) => (
            <IntentCard key={intent.id} intent={intent} onIntentChange={handleChange} />
          ))}
        </>
      )}
    </div>
  )
}
