import React from 'react'
import { Settings } from 'lucide-react'
import LogoMark from '../../LogoMark'
import type { TrayState } from '@shared/types'

export type Tab = 'queue' | 'routines'

interface Props {
  tab: Tab
  onTabChange: (t: Tab) => void
  onOpenMain: () => void
  trayState?: TrayState
}

export default function TabStrip({ tab, onTabChange, onOpenMain, trayState }: Props): React.ReactElement {
  return (
    <div className="tab-strip">
      <div className="tab-strip__logo">
        <LogoMark size={20} />
        <span className="tab-strip__name">mypa</span>
      </div>

      <div className="tab-strip__tabs">
        <button
          className={`tab-btn${tab === 'queue' ? ' active' : ''}`}
          onClick={() => onTabChange('queue')}
          style={{ position: 'relative' }}
        >
          Queue
          {(trayState === 'needs-you' || trayState === 'has-something') && (
            <span
              className={`tab-btn__dot tab-btn__dot--${trayState === 'needs-you' ? 'accent' : 'green'}`}
            />
          )}
        </button>
        <button
          className={`tab-btn${tab === 'routines' ? ' active' : ''}`}
          onClick={() => onTabChange('routines')}
        >
          Routines
        </button>
      </div>

      <div className="tab-strip__actions">
        <button className="icon-btn" title="Open mypa" onClick={onOpenMain}>
          <Settings size={14} strokeWidth={2} />
        </button>
      </div>
    </div>
  )
}
