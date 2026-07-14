import React, { useState, useEffect, useCallback, useRef } from 'react'
import { Eye, History, Radar, Inbox, ScrollText, RefreshCw, CheckCircle } from 'lucide-react'
import IntentCard from '../../widget/components/IntentCard'
import DigestView from '../../widget/components/DigestView'
import QueueView from '../../widget/components/QueueView'
import Tabs from '@renderer/components/Tabs'
import type { TabItem } from '@renderer/components/Tabs'
import { useLiveIntents } from '@renderer/hooks/useLiveIntents'
import { useLivePlanItems } from '@renderer/hooks/useLivePlanItems'
import type { Intent, PlanItem, ActionLogEntry } from '@shared/types'

type Section = 'queue' | 'observations' | 'history' | 'activity'
type PollState = 'idle' | 'polling' | 'done'

const TERMINAL_STATUSES: Intent['status'][] = ['executed', 'dismissed', 'challenged', 'failed', 'expired']

export default function InsightsPage(): React.ReactElement {
  const [section, setSection] = useState<Section>('queue')
  const { intents, setIntents, loading: intentsLoading } = useLiveIntents('all', 200)
  const { items, setItems, loading: itemsLoading } = useLivePlanItems()
  const [log, setLog] = useState<ActionLogEntry[]>([])
  const [logLoading, setLogLoading] = useState(true)
  const [pollState, setPollState] = useState<PollState>('idle')
  const pollDoneTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const api = window.electron
  const loading = intentsLoading || itemsLoading || logLoading

  // ── Log refresh helper ────────────────────────────────────────────────────
  const refreshLog = useCallback(() => {
    api.ambient.getLog(100)
      .then((entries) => setLog(entries as ActionLogEntry[]))
      .catch(console.error)
  }, [api])

  // ── Initial data fetch (intents/plan items come from the shared live hooks) ─
  useEffect(() => {
    setLogLoading(true)
    api.ambient.getLog(100)
      .then((fetchedLog) => setLog(fetchedLog as ActionLogEntry[]))
      .catch(console.error)
      .finally(() => setLogLoading(false))
  }, [])

  // ── Live updates not covered by the shared hooks ──────────────────────────
  useEffect(() => {
    // Refresh the action log whenever the agent executes something
    const offExecuted = api.on('ambient:action-executed', () => refreshLog())
    return () => {
      offExecuted()
    }
  }, [refreshLog])

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

  // Clean up the "done" confirmation timer on unmount so setState is never
  // called on an unmounted component.
  useEffect(() => () => {
    if (pollDoneTimer.current) clearTimeout(pollDoneTimer.current)
  }, [])

  function handlePollNow(): void {
    if (pollState !== 'idle') return
    setPollState('polling')
    api.ambient.pollNow()
      .then(() => {
        setPollState('done')
        if (pollDoneTimer.current) clearTimeout(pollDoneTimer.current)
        pollDoneTimer.current = setTimeout(() => setPollState('idle'), 2000)
        refreshLog()
      })
      .catch((e) => {
        console.error('[insights] pollNow failed:', e)
        setPollState('idle')
      })
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
    { id: 'activity', label: 'Activity', icon: <ScrollText size={13} strokeWidth={2} /> },
  ]

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div>
          <h1 className="page-title">Insights</h1>
          <p className="page-subtitle">Your daily digest, live observations, active tasks, and a full history of what the agent has surfaced.</p>
        </div>
        <button
          className="btn btn--ghost btn--sm"
          onClick={handlePollNow}
          disabled={pollState !== 'idle'}
          title="Trigger an immediate poll across all connected surfaces"
          style={{ marginTop: 4, flexShrink: 0 }}
        >
          {pollState === 'polling' ? (
            <RefreshCw size={13} strokeWidth={2} style={{ animation: 'spin 1s linear infinite' }} />
          ) : pollState === 'done' ? (
            <CheckCircle size={13} strokeWidth={2} />
          ) : (
            <RefreshCw size={13} strokeWidth={2} />
          )}
          {pollState === 'polling' ? 'Polling…' : pollState === 'done' ? 'Polled' : 'Poll now'}
        </button>
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

      {!loading && section === 'activity' && (
        log.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state__icon"><ScrollText size={28} strokeWidth={1.5} /></div>
            <h3>No activity yet</h3>
            <p>Every action the agent takes — surfacing, executing, or responding — is logged here.</p>
          </div>
        ) : (
          <ActivityLog entries={log} />
        )
      )}
    </div>
  )
}

// ─── Activity log renderer ────────────────────────────────────────────────────

function formatRelativeTime(iso: string): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000))
  if (diffSec < 60) return 'just now'
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffH = Math.floor(diffMin / 60)
  if (diffH < 24) return `${diffH}h ago`
  return `${Math.floor(diffH / 24)}d ago`
}

function ActivityLog({ entries }: { entries: ActionLogEntry[] }): React.ReactElement {
  // Tick every minute so relative timestamps stay current without waiting
  // for an external re-render trigger.
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000)
    return () => clearInterval(id)
  }, [])

  return (
    <div style={{ marginTop: 8 }}>
      {entries.map((entry) => (
        <div
          key={entry.id}
          style={{
            display: 'grid',
            gridTemplateColumns: '90px 1fr auto',
            alignItems: 'center',
            gap: '10px',
            padding: '7px 0',
            borderBottom: '1px solid var(--border-muted)',
            fontSize: 12
          }}
        >
          <span style={{ color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
            {formatRelativeTime(entry.created_at)}
          </span>
          <span style={{ color: 'var(--text-primary)' }}>
            <span style={{ color: 'var(--text-secondary)', marginRight: 6 }}>{entry.event}</span>
            {entry.action_type}
          </span>
          {entry.tier !== null && (
            <span
              style={{
                fontSize: 11,
                color: 'var(--text-muted)',
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border-muted)',
                borderRadius: 4,
                padding: '1px 6px',
                whiteSpace: 'nowrap'
              }}
            >
              tier {entry.tier}
            </span>
          )}
        </div>
      ))}
    </div>
  )
}
