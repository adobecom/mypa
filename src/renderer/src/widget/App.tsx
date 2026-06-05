import React, { useState, useEffect, useCallback } from 'react'
import TabStrip from './components/TabStrip'
import RoutinesFeed from './components/RoutinesFeed'
import PlanList from './components/PlanList'
import QuickAddBar from './components/QuickAddBar'
import PlanReviewCard from './components/PlanReviewCard'
import AmbientBackground from '../AmbientBackground'
import type { PlanDraft, PlanItem, RoutineRun, AppConfig } from '../../../../../shared/types'

type Tab = 'routines' | 'plan'

export default function App(): React.ReactElement {
  const [tab, setTab] = useState<Tab>('routines')
  const [planItems, setPlanItems] = useState<PlanItem[]>([])
  const [runs, setRuns] = useState<RoutineRun[]>([])
  const [draft, setDraft] = useState<PlanDraft | null>(null)
  const [drafting, setDrafting] = useState(false)
  const [config, setConfig] = useState<AppConfig | null>(null)

  const api = window.electron

  useEffect(() => {
    api.config.get().then(setConfig)
    api.plan.getAll().then(setPlanItems)
    api.routines.getAllRuns(20).then(setRuns)
  }, [])

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

    return () => {
      unsubRunStarted()
      unsubRunCompleted()
      unsubBadge()
    }
  }, [])

  const handleQuickAdd = useCallback(
    async (intent: string) => {
      if (!intent.trim()) return
      setDrafting(true)
      try {
        const d = await api.plan.createDraft(intent)
        setDraft(d)
        setTab('plan')
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

  const needsSetup = config !== null && !config.onboarding_complete

  return (
    <div style={{ position: 'relative', width: 380, height: 580 }}>
      <AmbientBackground variant="widget" />
      <div className="widget" style={{ position: 'relative', zIndex: 1 }}>
      <TabStrip
        tab={tab}
        onTabChange={setTab}
        onOpenMain={() => api.system.openMainWindow()}
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
        {draft && tab === 'plan' && (
          <PlanReviewCard
            draft={draft}
            onConfirm={handleConfirmDraft}
            onDismiss={() => setDraft(null)}
          />
        )}

        {tab === 'routines' && (
          <RoutinesFeed
            runs={runs}
            onRunsChange={setRuns}
          />
        )}

        {tab === 'plan' && (
          <PlanList
            items={planItems}
            onStatusChange={handleStatusChange}
            onItemsChange={setPlanItems}
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
