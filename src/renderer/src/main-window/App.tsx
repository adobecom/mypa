import React, { useState, useEffect, useRef } from 'react'
import { Zap, List, Settings as SettingsIcon, Network, BarChart3 } from 'lucide-react'
import LogoMark from '../LogoMark'
import AmbientBackground from '../AmbientBackground'
import RoutinesManager from './components/RoutinesManager'
import Settings from './components/Settings'
import RunLogs from './components/RunLogs'
import OnboardingWizard from './components/OnboardingWizard'
import MemoryGraph from './components/MemoryGraph'
import UsageDashboard from './components/UsageDashboard'
import { ToastProvider, useToast } from './toast/ToastProvider'
import type { AppConfig, RoutineRun, Intent } from '@shared/types'

type Page = 'routines' | 'logs' | 'settings' | 'memory' | 'usage'

// ─── Background-event → toast bridge ─────────────────────────────────────────
// Subscribes to routine:run-started/completed and ambient:action-executed and
// maps them to toasts. Must be called inside <ToastProvider>.

function useRunToasts(setPage: (p: Page) => void): void {
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
          action: { label: 'View logs', onClick: () => setPage('logs') }
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

const NAV: { id: Page; icon: React.ReactNode; label: string }[] = [
  { id: 'routines', icon: <Zap size={14} strokeWidth={2} />, label: 'Routines' },
  { id: 'logs', icon: <List size={14} strokeWidth={2} />, label: 'Run Logs' },
  { id: 'memory', icon: <Network size={14} strokeWidth={2} />, label: 'Memory' },
  { id: 'usage', icon: <BarChart3 size={14} strokeWidth={2} />, label: 'Usage' },
  { id: 'settings', icon: <SettingsIcon size={14} strokeWidth={2} />, label: 'Settings' }
]

// Inner shell (needs access to ToastProvider context via useRunToasts)
function AppShell(): React.ReactElement {
  const [page, setPage] = useState<Page>('routines')
  const [editRoutineId, setEditRoutineId] = useState<string | null>(null)
  const [config, setConfig] = useState<AppConfig | null>(null)

  useRunToasts(setPage)

  useEffect(() => {
    window.electron.config.get().then(setConfig)
  }, [])

  useEffect(() => {
    return window.electron.on('navigate:edit-routine', (id) => {
      setPage('routines')
      setEditRoutineId(id as string)
    })
  }, [])

  if (!config) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: 'var(--bg-base)', color: 'var(--text-muted)', fontSize: 13 }}>
        Loading…
      </div>
    )
  }

  if (!config.onboarding_complete) {
    return (
      <div style={{ position: 'relative', height: '100vh', overflow: 'hidden', background: 'var(--bg-base)' }}>
        <AmbientBackground variant="main" />
        <div style={{ position: 'relative', zIndex: 1, overflowY: 'auto', height: '100%' }}>
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
            {NAV.map((item) => (
              <button
                key={item.id}
                className={`nav-item${page === item.id ? ' active' : ''}`}
                onClick={() => setPage(item.id)}
              >
                <span className="nav-item__icon">{item.icon}</span>
                {item.label}
              </button>
            ))}
          </nav>
        </aside>

        <main
          className={page === 'memory' ? undefined : 'main-content'}
          style={page === 'memory' ? { flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', minWidth: 0 } : undefined}
        >
          {page === 'routines' && (
            <RoutinesManager
              editRoutineId={editRoutineId}
              onEditHandled={() => setEditRoutineId(null)}
            />
          )}
          {page === 'logs' && <RunLogs />}
          {page === 'memory' && <MemoryGraph />}
          {page === 'usage' && <UsageDashboard />}
          {page === 'settings' && <Settings />}
        </main>
      </div>
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
