import React, { useState, useEffect } from 'react'
import { Eye, BookOpen, History, Radar } from 'lucide-react'
import IntentCard from '../../widget/components/IntentCard'
import DigestView from '../../widget/components/DigestView'
import type { Intent } from '@shared/types'

type Section = 'observations' | 'digests' | 'history'

const TERMINAL_STATUSES: Intent['status'][] = ['executed', 'dismissed', 'challenged', 'failed', 'expired']

export default function ActivityPage(): React.ReactElement {
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

  const SECTIONS: { id: Section; label: string; icon: React.ReactNode; count: number }[] = [
    { id: 'observations', label: 'Observations', icon: <Eye size={13} strokeWidth={2} />, count: observations.length },
    { id: 'digests', label: 'Digests', icon: <BookOpen size={13} strokeWidth={2} />, count: digests.length },
    { id: 'history', label: 'History', icon: <History size={13} strokeWidth={2} />, count: history.length },
  ]

  return (
    <div className="main-content">
      <div className="page-header">
        <h1 className="page-title">Activity</h1>
        <p className="page-subtitle">Observations, digests, and a full history of what the agent has surfaced.</p>
      </div>

      {/* Section tabs */}
      <div style={{ display: 'flex', gap: 2, marginBottom: 16, borderBottom: '1px solid var(--border)', paddingBottom: 0 }}>
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            onClick={() => setSection(s.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 12px',
              fontSize: 12,
              fontWeight: section === s.id ? 600 : 400,
              color: section === s.id ? 'var(--text)' : 'var(--text-muted)',
              background: 'none',
              border: 'none',
              borderBottom: section === s.id ? '2px solid var(--accent)' : '2px solid transparent',
              cursor: 'pointer',
              marginBottom: -1,
              transition: 'color 0.15s, border-color 0.15s',
            }}
          >
            {s.icon}
            {s.label}
            {s.count > 0 && (
              <span style={{
                fontSize: 10,
                fontWeight: 600,
                color: section === s.id ? 'var(--accent)' : 'var(--text-muted)',
                background: section === s.id ? 'var(--accent-dim)' : 'var(--bg-raised)',
                borderRadius: 10,
                padding: '1px 5px',
              }}>
                {s.count}
              </span>
            )}
          </button>
        ))}
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

      {!loading && section === 'digests' && (
        <div>
          <DigestView />
          {digests.length > 0 && (
            <>
              <div className="section-header" style={{ marginTop: 16 }}>Digest intents</div>
              {digests.map((intent) => (
                <IntentCard key={intent.id} intent={intent} onIntentChange={handleIntentChange} />
              ))}
            </>
          )}
        </div>
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
