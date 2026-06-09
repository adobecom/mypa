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
  const active = intents.filter((i) => !TERMINAL_STATUSES.includes(i.status))
  const actions = active.filter((i) => i.type === 'action')
  const observations = active.filter((i) => i.type === 'suggestion' || i.type === 'flag')
  const digests = active.filter((i) => i.type === 'digest')
  const recent = intents.filter((i) => TERMINAL_STATUSES.includes(i.status)).slice(0, 5)

  const actionsNeedApproval = actions.some((i) => i.required_approval && i.tier >= 2)

  function handleChange(updated: Intent): void {
    onIntentsChange(intents.map((i) => (i.id === updated.id ? updated : i)))
  }

  if (intents.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state__icon"><Radar size={28} strokeWidth={1.5} /></div>
        <h3>All quiet</h3>
        <p>The agent is watching your surfaces.</p>
      </div>
    )
  }

  return (
    <div>
      {actions.length > 0 && (
        <>
          <div
            className="section-header"
            style={actionsNeedApproval ? { color: 'var(--accent)' } : undefined}
          >
            Actions
          </div>
          {actions.map((intent) => (
            <IntentCard key={intent.id} intent={intent} onIntentChange={handleChange} />
          ))}
        </>
      )}

      {observations.length > 0 && (
        <>
          <div className="section-header">Observations</div>
          {observations.map((intent) => (
            <IntentCard key={intent.id} intent={intent} onIntentChange={handleChange} />
          ))}
        </>
      )}

      {digests.length > 0 && (
        <>
          <div className="section-header">Digests</div>
          {digests.map((intent) => (
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
