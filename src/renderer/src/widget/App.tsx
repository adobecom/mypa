import React, { useState, useEffect, useCallback, useMemo } from 'react'
import TabStrip, { type Tab } from './components/TabStrip'
import RoutinesFeed from './components/RoutinesFeed'
import QueueView from './components/QueueView'
import QuickAddBar from './components/QuickAddBar'
import PlanReviewCard from './components/PlanReviewCard'
import AmbientBackground from '../AmbientBackground'
import type { PlanDraft, PlanItem, RoutineRun, AppConfig, Intent, TrayState } from '@shared/types'

export default function App(): React.ReactElement {
  const [tab, setTab] = useState<Tab>('queue')
  const [planItems, setPlanItems] = useState<PlanItem[]>([])
  const [runs, setRuns] = useState<RoutineRun[]>([])
  const [draft, setDraft] = useState<PlanDraft | null>(null)
  const [drafting, setDrafting] = useState(false)
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [intents, setIntents] = useState<Intent[]>([])
  const [trayState, setTrayState] = useState<TrayState>('idle')

  const api = window.electron

  useEffect(() => {
    api.config.get().then(setConfig)
    api.plan.getAll().then(setPlanItems)
    api.routines.getAllRuns(20).then(setRuns)
    api.ambient.getIntents().then((items) => setIntents(items as Intent[]))
    api.ambient.getTrayState().then((s) => setTrayState(s as TrayState))
  }, [])

  // Re-fetch config on focus so the setup banner clears after onboarding completes
  useEffect(() => {
    const onFocus = () => api.config.get().then(setConfig)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [api])

  // Push event listeners
  useEffect(() => {
    const unsubRunStarted = api.on('routine:run-started', (run) => {
      setRuns((prev) => [run as RoutineRun, ...prev.slice(0, 19)])
      setTab('routines')
    })
    const unsubRunCompleted = api.on('routine:run-completed', (run) => {
      setRuns((prev) =>
        prev.map((r) => ((r as RoutineRun).id === (run as RoutineRun).id ? (run as RoutineRun) : r))
      )
    })
    const unsubBadge = api.on('badge:updated', () => {
      api.plan.getAll().then(setPlanItems)
    })
    const unsubIntentCreated = api.on('ambient:intent-created', (intent) => {
      const i = intent as Intent
      setIntents((prev) => [i, ...prev.filter((x) => x.id !== i.id)])
      // Switch to Queue for pending actionable intents so the user sees the card.
      // Terminal intents (executed/dismissed etc.) do not bounce the tab.
      const TERMINAL: Intent['status'][] = ['executed', 'dismissed', 'challenged', 'failed', 'expired']
      if (i.type === 'action' && !TERMINAL.includes(i.status)) {
        setTab('queue')
      }
    })
    const unsubIntentUpdated = api.on('ambient:intent-updated', (updated) => {
      const u = updated as Partial<Intent> & { id: string }
      setIntents((prev) => prev.map((i) => (i.id === u.id ? { ...i, ...u } : i)))
    })
    const unsubTrayState = api.on('ambient:tray-state', (s) => {
      setTrayState(s as TrayState)
    })

    return () => {
      unsubRunStarted()
      unsubRunCompleted()
      unsubBadge()
      unsubIntentCreated()
      unsubIntentUpdated()
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
