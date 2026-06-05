import React, { useState, useEffect } from 'react'
import { Zap, List, Settings as SettingsIcon } from 'lucide-react'
import LogoMark from '../LogoMark'
import AmbientBackground from '../AmbientBackground'
import RoutinesManager from './components/RoutinesManager'
import Settings from './components/Settings'
import RunLogs from './components/RunLogs'

type Page = 'routines' | 'logs' | 'settings'

const NAV: { id: Page; icon: React.ReactNode; label: string }[] = [
  { id: 'routines', icon: <Zap size={14} strokeWidth={2} />, label: 'Routines' },
  { id: 'logs', icon: <List size={14} strokeWidth={2} />, label: 'Run Logs' },
  { id: 'settings', icon: <SettingsIcon size={14} strokeWidth={2} />, label: 'Settings' }
]

export default function App(): React.ReactElement {
  const [page, setPage] = useState<Page>('routines')
  const [editRoutineId, setEditRoutineId] = useState<string | null>(null)

  useEffect(() => {
    return window.electron.on('navigate:edit-routine', (id) => {
      setPage('routines')
      setEditRoutineId(id as string)
    })
  }, [])

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

        <main className="main-content">
          {page === 'routines' && (
            <RoutinesManager
              editRoutineId={editRoutineId}
              onEditHandled={() => setEditRoutineId(null)}
            />
          )}
          {page === 'logs' && <RunLogs />}
          {page === 'settings' && <Settings />}
        </main>
      </div>
    </div>
  )
}
