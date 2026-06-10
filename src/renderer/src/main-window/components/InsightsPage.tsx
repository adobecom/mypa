import React, { useState, useEffect } from 'react'
import { Eye, History, Radar, Inbox } from 'lucide-react'
import IntentCard from '../../widget/components/IntentCard'
import DigestView from '../../widget/components/DigestView'
import QueueView from '../../widget/components/QueueView'
import Tabs from '@renderer/components/Tabs'
import type { TabItem } from '@renderer/components/Tabs'
import type { Intent, PlanItem } from '@shared/types'

type Section = 'queue' | 'observations' | 'history'

const TERMINAL_STATUSES: Intent['status'][] = ['executed', 'dismissed', 'challenged', 'failed', 'expired']

export default function InsightsPage(): React.ReactElement {
  const [section, setSection] = useState<Section>('queue')
  const [intents, setIntents] = useState<Intent[]>([])
  const [items, setItems] = useState<PlanItem[]>([])
  const [loading, setLoading] = useState(true)

  const api = window.electron

  // ── Initial data fetch ────────────────────────────────────────────────────
  useEffect(() => {
    setLoading(true)
    Promise.all([
      api.ambient.getAllIntents(200),
      api.plan.getAll()
    ])
      .then(([fetchedIntents, fetchedItems]) => {
        setIntents((prev) => {
          const byId = new Map((fetchedIntents as Intent[]).map((i) => [i.id, i]))
          for (const p of prev) {
            if (!byId.has(p.id)) byId.set(p.id, p)
          }
          return Array.from(byId.values())
        })
        setItems(fetchedItems as PlanItem[])
      })
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [])

  // ── Live updates ──────────────────────────────────────────────────────────
  useEffect(() => {
    const offCreated = api.on('ambient:intent-created', (intent) => {
      const i = intent as Intent
      setIntents((prev) => [i, ...prev.filter((x) => x.id !== i.id)])
    })
    const offUpdated = api.on('ambient:intent-updated', (updated) => {
      const u = updated as Partial<Intent> & { id: string }
      setIntents((prev) => prev.map((i) => (i.id === u.id ? { ...i, ...u } : i)))
    })
    const offItemUpdated = api.on('plan:item-updated', (item) => {
      const p = item as PlanItem
      setItems((prev) => prev.map((i) => (i.id === p.id ? p : i)))
    })
    // Re-fetch plan items when the badge changes (e.g. new item created)
    const offBadge = api.on('badge:updated', () => {
      api.plan.getAll().then((list) => setItems(list as PlanItem[])).catch(console.error)
    })
    return () => {
      offCreated()
      offUpdated()
      offItemUpdated()
      offBadge()
    }
  }, [])

  // ── Intent change handler (approve/dismiss/challenge from QueueView/IntentCard)
  function handleIntentChange(updated: Intent): void {
    setIntents((prev) => prev.map((i) => (i.id === updated.id ? updated : i)))
  }

  function handleIntentsChange(updated: Intent[]): void {
    setIntents(updated)
  }

  function handleStatusChange(id: string, status: PlanItem['status']): void {
    api.plan.updateStatus(id, status).catch(console.error)
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, status } : i)))
  }

  function handleItemsChange(updated: PlanItem[]): void {
    setItems(updated)
  }

  // ── Partition intents ─────────────────────────────────────────────────────
  const actionIntents = intents.filter((i) => i.type === 'action')
  const observations = intents.filter(
    (i) => (i.type === 'suggestion' || i.type === 'flag') && !TERMINAL_STATUSES.includes(i.status)
  )
  const digests = intents.filter(
    (i) => i.type === 'digest' && !TERMINAL_STATUSES.includes(i.status)
  )
  const history = intents.filter((i) => TERMINAL_STATUSES.includes(i.status))

  // Queue badge: pending action intents + active plan items
  const pendingActionIntents = actionIntents.filter((i) => !TERMINAL_STATUSES.includes(i.status))
  const activePlanItems = items.filter((i) => i.status === 'pending' || i.status === 'in_progress')
  const queueCount = pendingActionIntents.length + activePlanItems.length

  const TABS: TabItem[] = [
    { id: 'queue', label: 'Queue', icon: <Inbox size={13} strokeWidth={2} />, count: queueCount },
    { id: 'observations', label: 'Observations', icon: <Eye size={13} strokeWidth={2} />, count: observations.length },
    { id: 'history', label: 'History', icon: <History size={13} strokeWidth={2} />, count: history.length },
  ]

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Insights</h1>
        <p className="page-subtitle">Your daily digest, live observations, active tasks, and a full history of what the agent has surfaced.</p>
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

      {/* Tabs: Queue / Observations / History */}
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

      {!loading && section === 'queue' && (
        <QueueView
          intents={actionIntents}
          onIntentsChange={handleIntentsChange}
          items={items}
          onStatusChange={handleStatusChange}
          onItemsChange={handleItemsChange}
        />
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
