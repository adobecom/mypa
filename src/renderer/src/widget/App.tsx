import React, { useState, useEffect, useCallback, useMemo } from 'react'
import TabStrip, { type Tab } from './components/TabStrip'
import RoutinesFeed from './components/RoutinesFeed'
import QueueView from './components/QueueView'
import QuickAddBar from './components/QuickAddBar'
import PlanReviewCard from './components/PlanReviewCard'
import AmbientBackground from '../AmbientBackground'
import { useLiveRuns } from '@renderer/hooks/useLiveRuns'
import { useLiveIntents } from '@renderer/hooks/useLiveIntents'
import { useLivePlanItems } from '@renderer/hooks/useLivePlanItems'
import type { PlanDraft, PlanItem, RoutineRun, AppConfig, Intent, TrayState } from '@shared/types'

export default function App(): React.ReactElement {
  const [tab, setTab] = useState<Tab>('queue')
  const { items: planItems, setItems: setPlanItems } = useLivePlanItems()
  const { runs, setRuns } = useLiveRuns(20)
  const { intents, setIntents } = useLiveIntents('pending')
  const [draft, setDraft] = useState<PlanDraft | null>(null)
  const [drafting, setDrafting] = useState(false)
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [trayState, setTrayState] = useState<TrayState>('idle')

  const api = window.electron

  useEffect(() => {
    api.config.get().then(setConfig)
    api.ambient.getTrayState().then((s) => setTrayState(s as TrayState))
  }, [])

  // Re-fetch config on focus so the setup banner clears after onboarding completes
  useEffect(() => {
    const onFocus = () => api.config.get().then(setConfig)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [api])

  // UI-only reactions to push events — data itself is owned by the live-data
  // hooks above; these just decide which tab to jump to.
  useEffect(() => {
    const unsubRunStarted = api.on('routine:run-started', () => {
      setTab('routines')
    })
    const unsubIntentCreated = api.on('ambient:intent-created', (intent) => {
      const i = intent as Intent
      // Switch to Queue for pending actionable intents so the user sees the card.
      // Terminal intents (executed/dismissed etc.) do not bounce the tab.
      const TERMINAL: Intent['status'][] = ['executed', 'dismissed', 'challenged', 'failed', 'expired']
      if (i.type === 'action' && !TERMINAL.includes(i.status)) {
        setTab('queue')
      }
    })
    const unsubTrayState = api.on('ambient:tray-state', (s) => {
      setTrayState(s as TrayState)
    })

    return () => {
      unsubRunStarted()
      unsubIntentCreated()
      unsubTrayState()
    }
  }, [])

  const handleQuickAdd = useCallback(
    async (intent: string) => {
      if (!intent.trim()) return
      setDrafting(true)
      try {
        const d = await api.plan.createDraft(intent)
        setDraft(d)
        setTab('queue')
      } catch (err: any) {
        console.error('Draft error:', err)
      } finally {
        setDrafting(false)
      }
    },
    [api]
  )

  const handleConfirmDraft = useCallback(
    async (d: PlanDraft) => {
      const item = await api.plan.confirm(d)
      setPlanItems((prev) => [item, ...prev])
      setDraft(null)
    },
    [api]
  )

  const handleStatusChange = useCallback(
    async (id: string, status: PlanItem['status']) => {
      await api.plan.updateStatus(id, status)
      setPlanItems((prev) => prev.map((p) => (p.id === id ? { ...p, status } : p)))
    },
    [api]
  )

  // ── Entity linkage indexes (memoized) ────────────────────────────────────────
  // entityKeyToIntent: maps a work-item key (e.g. "github:pull_request:482") to the
  //   most-recent intent whose focus nodes include that key.
  // entityKeyToRuns: maps the same key to the list of runs that cover that entity.
  // Both are built from already-loaded state — no extra IPC calls needed.

  const entityKeyToIntent = useMemo((): Map<string, Intent> => {
    const map = new Map<string, Intent>()
    for (const intent of intents) {
      const focusNodes = (intent.context_packet?.focusNodes ?? []) as Array<{ key?: string }>
      for (const node of focusNodes) {
        if (!node.key) continue
        // Keep the most-recent intent for each key (intents are newest-first from getIntents)
        if (!map.has(node.key)) {
          map.set(node.key, intent)
        }
      }
    }
    return map
  }, [intents])

  const entityKeyToRuns = useMemo((): Map<string, RoutineRun[]> => {
    const map = new Map<string, RoutineRun[]>()
    for (const run of runs) {
      for (const entity of run.covered_entities ?? []) {
        if (!entity.key) continue
        if (!map.has(entity.key)) map.set(entity.key, [])
        map.get(entity.key)!.push(run)
      }
    }
    return map
  }, [runs])

  const needsSetup = config !== null && !config.onboarding_complete

  return (
    <div style={{ position: 'relative', width: 440, height: 580 }}>
      <AmbientBackground variant="widget" />
      <div className="widget" style={{ position: 'relative', zIndex: 1 }}>
        <TabStrip
          tab={tab}
          onTabChange={setTab}
          onOpenMain={() => api.system.openMainWindow()}
          trayState={trayState}
        />

        {needsSetup && (
          <div className="setup-banner">
            <span className="setup-banner__text">Finish setup to get started</span>
            <button className="setup-banner__btn" onClick={() => api.system.openMainWindow()}>
              Set up →
            </button>
          </div>
        )}

        <div className="content">
          {draft && tab === 'queue' && (
            <PlanReviewCard
              draft={draft}
              onConfirm={handleConfirmDraft}
              onDismiss={() => setDraft(null)}
            />
          )}

          {tab === 'queue' && (
            <QueueView
              intents={intents}
              onIntentsChange={setIntents}
              items={planItems}
              onStatusChange={handleStatusChange}
              onItemsChange={setPlanItems}
              entityKeyToRuns={entityKeyToRuns}
            />
          )}

          {tab === 'routines' && (
            <RoutinesFeed
              runs={runs}
              onRunsChange={setRuns}
              entityKeyToIntent={entityKeyToIntent}
            />
          )}
        </div>

        <QuickAddBar
          tab={tab}
          onSubmit={handleQuickAdd}
          loading={drafting}
          disabled={!!needsSetup}
        />
      </div>
    </div>
  )
}
