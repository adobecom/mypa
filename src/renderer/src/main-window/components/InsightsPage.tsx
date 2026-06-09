import React, { useState, useEffect } from 'react'
import { Eye, History, Radar } from 'lucide-react'
import IntentCard from '../../widget/components/IntentCard'
import DigestView from '../../widget/components/DigestView'
import Tabs from '@renderer/components/Tabs'
import type { TabItem } from '@renderer/components/Tabs'
import type { Intent } from '@shared/types'

type Section = 'observations' | 'history'

const TERMINAL_STATUSES: Intent['status'][] = ['executed', 'dismissed', 'challenged', 'failed', 'expired']

export default function InsightsPage(): React.ReactElement {
  const [section, setSection] = useState<Section>('observations')
  const [intents, setIntents] = useState<Intent[]>([])
  const [loading, setLoading] = useState(true)

  const api = window.electron

  useEffect(() => {
    setLoading(true)
    api.ambient.getAllIntents(200)
      .then((items) => {
        const fetched = items as Intent[]
        // Merge rather than replace: push-event items that arrived while the fetch
        // was in-flight would be overwritten if we called setIntents(fetched) directly.
        // Keep any prev items not in the snapshot — they're newer than the DB query window.
        setIntents((prev) => {
          const byId = new Map(fetched.map((i) => [i.id, i]))
          for (const p of prev) {
            if (!byId.has(p.id)) byId.set(p.id, p)
          }
          return Array.from(byId.values())
        })
      })
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [])

  // Live-update: pick up new intents and status changes from the backend
  useEffect(() => {
    const offCreated = api.on('ambient:intent-created', (intent) => {
      const i = intent as Intent
      setIntents((prev) => [i, ...prev.filter((x) => x.id !== i.id)])
    })
    const offUpdated = api.on('ambient:intent-updated', (updated) => {
      const u = updated as Partial<Intent> & { id: string }
      setIntents((prev) => prev.map((i) => (i.id === u.id ? { ...i, ...u } : i)))
    })
    return () => {
      offCreated()
      offUpdated()
    }
  }, [])

  function handleIntentChange(updated: Intent): void {
    setIntents((prev) => prev.map((i) => (i.id === updated.id ? updated : i)))
  }

  // Partition intents by type for each section
  const observations = intents.filter(
    (i) => (i.type === 'suggestion' || i.type === 'flag') && !TERMINAL_STATUSES.includes(i.status)
  )
  const digests = intents.filter(
    (i) => i.type === 'digest' && !TERMINAL_STATUSES.includes(i.status)
  )
  const history = intents.filter((i) => TERMINAL_STATUSES.includes(i.status))

  const TABS: TabItem[] = [
    { id: 'observations', label: 'Observations', icon: <Eye size={13} strokeWidth={2} />, count: observations.length },
    { id: 'history', label: 'History', icon: <History size={13} strokeWidth={2} />, count: history.length },
  ]

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Insights</h1>
        <p className="page-subtitle">Your daily digest, live observations, and a full history of what the agent has surfaced.</p>
      </div>

      {/* Always-on daily digest */}
      <DigestView />
      {!loading && digests.length > 0 && (
        <>
          <div className="section-header" style={{ marginTop: 8 }}>Recent digests</div>
          {digests.map((intent) => (
            <IntentCard key={intent.id} intent={intent} onIntentChange={handleIntentChange} />
          ))}
        </>
      )}

      {/* Observations / History tabs */}
      <div style={{ marginTop: 20 }}>
        <Tabs
          items={TABS}
          active={section}
          onChange={(id) => setSection(id as Section)}
        />
      </div>

      {loading && (
        <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: 16 }}>Loading…</div>
      )}

      {!loading && section === 'observations' && (
        observations.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state__icon"><Radar size={28} strokeWidth={1.5} /></div>
            <h3>No observations</h3>
            <p>The agent will surface patterns, spikes, and flags here.</p>
          </div>
        ) : (
          <div>
            {observations.map((intent) => (
              <IntentCard key={intent.id} intent={intent} onIntentChange={handleIntentChange} />
            ))}
          </div>
        )
      )}

      {!loading && section === 'history' && (
        history.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state__icon"><History size={28} strokeWidth={1.5} /></div>
            <h3>No history yet</h3>
            <p>Approved, dismissed, and challenged actions will appear here.</p>
          </div>
        ) : (
          <div>
            {history.map((intent) => (
              <IntentCard key={intent.id} intent={intent} onIntentChange={handleIntentChange} />
            ))}
          </div>
        )
      )}
    </div>
  )
}
