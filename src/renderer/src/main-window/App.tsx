import React, { useState, useEffect, useRef } from 'react'
import { Zap, Settings as SettingsIcon, Network, BarChart3, LayoutList, MessageSquare, Sparkles } from 'lucide-react'
import LogoMark from '../LogoMark'
import AmbientBackground from '../AmbientBackground'
import Settings from './components/Settings'
import OnboardingWizard from './components/OnboardingWizard'
import MemoryGraph from './components/MemoryGraph'
import UsageDashboard from './components/UsageDashboard'
import PlanItemDetail from './components/PlanItemDetail'
import CheckInPage from './components/CheckInPage'
import InsightsPage from './components/InsightsPage'
import RoutinesPage from './components/RoutinesPage'
import type { RoutinesTab } from './components/RoutinesPage'
import { ToastProvider, useToast } from './toast/ToastProvider'
import type { AppConfig, RoutineRun, Intent, PlanItem } from '@shared/types'

type Page = 'routines' | 'settings' | 'memory' | 'usage' | 'plan' | 'checkin' | 'insights'

// ─── Background-event → toast bridge ─────────────────────────────────────────
// Subscribes to routine:run-started/completed and ambient:action-executed and
// maps them to toasts. Must be called inside <ToastProvider>.

function useRunToasts(setPage: (p: Page) => void, setRoutinesTab: (t: RoutinesTab) => void): void {
  const toast = useToast()
  // Map runId → toastId so we can update a "running…" toast on completion
  const runToastMap = useRef<Map<string, string>>(new Map())

  useEffect(() => {
    const offStarted = window.electron.on('routine:run-started', (...args) => {
      const run = args[0] as RoutineRun
      const id = toast.loading(`Running ${run.routine_name}…`)
      runToastMap.current.set(run.id, id)
    })

    const offCompleted = window.electron.on('routine:run-completed', (...args) => {
      const run = args[0] as RoutineRun
      const toastId = runToastMap.current.get(run.id)
      runToastMap.current.delete(run.id)

      if (run.status === 'error') {
        const opts = {
          message: run.error ?? 'Routine failed',
          duration: 8000
        }
        if (toastId) {
          toast.update(toastId, { variant: 'error', title: `${run.routine_name} failed`, ...opts })
        } else {
          toast.error(`${run.routine_name} failed`, opts)
        }
      } else {
        const opts = {
          action: { label: 'View', onClick: () => { setRoutinesTab('needs'); setPage('routines') } }
        }
        if (toastId) {
          toast.update(toastId, { variant: 'success', title: `${run.routine_name} complete`, ...opts })
        } else {
          toast.success(`${run.routine_name} complete`, opts)
        }
      }
    })

    const offAmbient = window.electron.on('ambient:action-executed', (...args) => {
      const intent = args[0] as Intent
      const summary = intent.rationale
        ? intent.rationale.slice(0, 100)
        : `${intent.surface ?? 'ambient'}:${intent.verb ?? 'action'}`
      toast.info(`mypa auto-ran: ${intent.surface ?? 'ambient'}`, { message: summary })
    })

    return () => {
      offStarted()
      offCompleted()
      offAmbient()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps — setPage and toast are stable refs
}

function useUpdateToasts(): void {
  const toast = useToast()
  const toastIdRef = useRef<string | null>(null)

  useEffect(() => {
    const offAvailable = window.electron.on('update:available', (...args) => {
      const info = args[0] as { version: string }
      const id = toast.loading(`Downloading update v${info.version}`)
      toastIdRef.current = id
    })

    const offDownloaded = window.electron.on('update:downloaded', () => {
      const id = toastIdRef.current
      const opts = {
        duration: 0,
        action: {
          label: 'Restart to install',
          onClick: () => window.electron.update.install()
        }
      }
      if (id) {
        toast.update(id, { variant: 'success', title: 'Update ready', ...opts })
      } else {
        toast.show({ variant: 'success', title: 'Update ready', ...opts })
      }
    })

    const offError = window.electron.on('update:error', (...args) => {
      const message = args[0] as string
      const id = toastIdRef.current
      toastIdRef.current = null
      if (id) {
        toast.update(id, { variant: 'error', title: 'Update failed', message })
      } else {
        toast.error('Update failed', { message })
      }
    })

    return () => {
      offAvailable()
      offDownloaded()
      offError()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps — toast is stable
}

const NAV: { id: Page; icon: React.ReactNode; label: string }[] = [
  { id: 'routines', icon: <Zap size={14} strokeWidth={2} />, label: 'Routines' },
  { id: 'insights', icon: <Sparkles size={14} strokeWidth={2} />, label: 'Insights' },
  { id: 'checkin', icon: <MessageSquare size={14} strokeWidth={2} />, label: 'Check-in' },
  { id: 'memory', icon: <Network size={14} strokeWidth={2} />, label: 'Memory' },
  { id: 'usage', icon: <BarChart3 size={14} strokeWidth={2} />, label: 'Usage' },
  { id: 'settings', icon: <SettingsIcon size={14} strokeWidth={2} />, label: 'Settings' }
]

const NAV_HIDDEN: Set<Page> = new Set(['plan'])

// Inner shell (needs access to ToastProvider context via useRunToasts)
function AppShell(): React.ReactElement {
  const [page, setPage] = useState<Page>('routines')
  const [routinesTab, setRoutinesTab] = useState<RoutinesTab>('routines')
  const [editRoutineId, setEditRoutineId] = useState<string | null>(null)
  const [activePlanItemId, setActivePlanItemId] = useState<string | null>(null)
  const [navigateRunId, setNavigateRunId] = useState<string | null>(null)
  const [activeCheckinId, setActiveCheckinId] = useState<string | null>(null)
  const [config, setConfig] = useState<AppConfig | null>(null)
  // Per-page unread counts for sidebar indicators
  const [insightsBadge, setInsightsBadge] = useState(0)
  const [routinesBadge, setRoutinesBadge] = useState(0)
  // Set by <Settings onDirtyChange> — gates navigating away from Settings with pending edits
  const [settingsDirty, setSettingsDirty] = useState(false)
  const [pendingNavigation, setPendingNavigation] = useState<{ page: Page; after?: () => void } | null>(null)

  // All in-app navigation should go through this — it intercepts leaving Settings with
  // unsaved edits and asks for confirmation instead of navigating immediately.
  function requestNavigate(next: Page, after?: () => void): void {
    if (next !== page && page === 'settings' && settingsDirty) {
      setPendingNavigation({ page: next, after })
      return
    }
    setPage(next)
    after?.()
  }

  // requestNavigate closes over `page`/`settingsDirty` from the render it's defined in,
  // so a listener registered in a mount-only effect ([] deps) would keep calling a stale
  // version forever. This ref always points at the latest closure without having to
  // re-subscribe the IPC listeners below on every render.
  const requestNavigateRef = useRef(requestNavigate)
  useEffect(() => {
    requestNavigateRef.current = requestNavigate
  })

  function confirmDiscardAndLeave(): void {
    if (!pendingNavigation) return
    setPage(pendingNavigation.page)
    pendingNavigation.after?.()
    setSettingsDirty(false)
    setPendingNavigation(null)
  }

  useRunToasts(setPage, setRoutinesTab)
  useUpdateToasts()

  useEffect(() => {
    window.electron.config.get().then(setConfig)
  }, [])

  // Compute sidebar badge counts from live data
  useEffect(() => {
    async function refreshBadges(): Promise<void> {
      try {
        const [intents, planItems, runs] = await Promise.all([
          window.electron.ambient.getIntents(),
          window.electron.plan.getAll(),
          window.electron.routines.getAllRuns(100)
        ])
        const pendingActions = (intents as Intent[]).filter((i) => i.type === 'action')
        const activePlans = (planItems as PlanItem[]).filter(
          (i) => i.status === 'pending' || i.status === 'in_progress'
        )
        const pendingRuns = (runs as RoutineRun[]).filter((r) => r.status === 'pending_response')
        setInsightsBadge(pendingActions.length + activePlans.length)
        setRoutinesBadge(pendingRuns.length)
      } catch {
        // Non-fatal — badges degrade silently
      }
    }

    refreshBadges()
    const subs = [
      window.electron.on('badge:updated', () => { void refreshBadges() }),
      window.electron.on('ambient:intent-created', () => { void refreshBadges() }),
      window.electron.on('ambient:intent-updated', () => { void refreshBadges() }),
      window.electron.on('plan:item-updated', () => { void refreshBadges() }),
    ]
    return () => subs.forEach((unsub) => unsub())
  }, [])

  useEffect(() => {
    // Routed through requestNavigateRef (not setPage directly) so a background push
    // event arriving while Settings has unsaved edits shows the same confirm overlay
    // instead of silently discarding them.
    const offRoutine = window.electron.on('navigate:edit-routine', (id) => {
      requestNavigateRef.current('routines', () => {
        setEditRoutineId(id as string)
        setRoutinesTab('routines')
      })
    })
    const offPlanItem = window.electron.on('navigate:plan-item', (id) => {
      requestNavigateRef.current('plan', () => setActivePlanItemId(id as string))
    })
    const offRunChat = window.electron.on('navigate:run-chat', (id) => {
      requestNavigateRef.current('routines', () => {
        setNavigateRunId(id as string)
        setRoutinesTab('logs')
      })
    })
    const offCheckin = window.electron.on('navigate:checkin', (id) => {
      requestNavigateRef.current('checkin', () => setActiveCheckinId((id as string | null) ?? null))
    })
    return () => {
      offRoutine()
      offPlanItem()
      offRunChat()
      offCheckin()
    }
  }, [])

  if (!config) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--bg-base)' }}>
        <div className="drag-strip" />
        <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
          Loading…
        </div>
      </div>
    )
  }

  if (!config.onboarding_complete) {
    return (
      <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', background: 'var(--bg-base)' }}>
        <AmbientBackground variant="main" />
        {/* Real layout space, not overlaid on the scrollable content below — an absolutely
            positioned strip would get scrolled-over content underneath it, making that
            content unclickable (and drag the window instead) whenever a step's content
            is taller than the viewport. */}
        <div className="drag-strip" style={{ position: 'relative', zIndex: 1 }} />
        <div style={{ position: 'relative', zIndex: 1, overflowY: 'auto', flex: 1, minHeight: 0 }}>
          <OnboardingWizard onComplete={() => window.electron.config.get().then(setConfig)} />
        </div>
      </div>
    )
  }

  return (
    <div style={{ position: 'relative', height: '100vh', overflow: 'hidden', background: 'var(--bg-base)' }}>
      <AmbientBackground variant="main" />
      <div className="app-shell" style={{ position: 'relative', zIndex: 1 }}>
        <aside className="sidebar">
          <div className="sidebar__logo">
            <LogoMark size={26} />
            <span className="sidebar__name">mypa</span>
          </div>

          <nav className="sidebar__nav">
            {NAV.filter((item) => !NAV_HIDDEN.has(item.id)).map((item) => {
              const badge =
                item.id === 'insights' ? insightsBadge
                : item.id === 'routines' ? routinesBadge
                : 0
              return (
                <button
                  key={item.id}
                  className={`nav-item${page === item.id ? ' active' : ''}`}
                  onClick={() => {
                    requestNavigate(item.id, () => {
                      if (item.id === 'routines') setRoutinesTab(routinesBadge > 0 ? 'needs' : 'routines')
                    })
                  }}
                >
                  <span className="nav-item__icon">{item.icon}</span>
                  {item.label}
                  {badge > 0 && (
                    <span className="nav-item__badge">{badge}</span>
                  )}
                </button>
              )
            })}
            {page === 'plan' && (
              <button className="nav-item active" disabled>
                <span className="nav-item__icon"><LayoutList size={14} strokeWidth={2} /></span>
                Plan item
              </button>
            )}
          </nav>
        </aside>

        <main
          className={page === 'memory' ? undefined : 'main-content'}
          style={page === 'memory' ? { flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', minWidth: 0 } : undefined}
        >
          {page === 'routines' && (
            <RoutinesPage
              editRoutineId={editRoutineId}
              onEditHandled={() => setEditRoutineId(null)}
              initialRunId={navigateRunId}
              onInitialRunHandled={() => setNavigateRunId(null)}
              tab={routinesTab}
              onTabChange={setRoutinesTab}
              pendingCount={routinesBadge}
            />
          )}
          {page === 'memory' && <MemoryGraph />}
          {page === 'usage' && <UsageDashboard />}
          {page === 'settings' && <Settings onDirtyChange={setSettingsDirty} />}
          {page === 'insights' && <InsightsPage />}
          {page === 'checkin' && (
            <CheckInPage
              activeCheckinId={activeCheckinId}
              onCheckinHandled={() => setActiveCheckinId(null)}
            />
          )}
          {page === 'plan' && (
            <PlanItemDetail
              itemId={activePlanItemId}
              onBack={() => setPage('routines')}
            />
          )}
        </main>
      </div>

      {pendingNavigation && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 50,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(0, 0, 0, 0.5)'
          }}
        >
          <div className="card" style={{ maxWidth: 360, margin: 0 }}>
            <div className="card__header">
              <div className="card__title">Unsaved changes</div>
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16 }}>
              You have unsaved changes in Settings. Leaving now will discard them.
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn btn--ghost btn--sm" onClick={() => setPendingNavigation(null)}>
                Cancel
              </button>
              <button className="btn btn--danger btn--sm" onClick={confirmDiscardAndLeave}>
                Discard &amp; leave
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default function App(): React.ReactElement {
  return (
    <ToastProvider>
      <AppShell />
    </ToastProvider>
  )
}
