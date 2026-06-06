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
  const needsYou = intents.filter((i) => !TERMINAL_STATUSES.includes(i.status) && i.required_approval && i.tier >= 2)
  const suggestions = intents.filter((i) => !TERMINAL_STATUSES.includes(i.status) && !(i.required_approval && i.tier >= 2))
  const recent = intents.filter((i) => TERMINAL_STATUSES.includes(i.status)).slice(0, 5)

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
      {needsYou.length > 0 && (
        <>
          <div className="section-header" style={{ color: 'var(--accent)' }}>Needs You</div>
          {needsYou.map((intent) => (
            <IntentCard key={intent.id} intent={intent} onIntentChange={handleChange} />
          ))}
        </>
      )}

      {suggestions.length > 0 && (
        <>
          <div className="section-header">Suggestions</div>
          {suggestions.map((intent) => (
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
