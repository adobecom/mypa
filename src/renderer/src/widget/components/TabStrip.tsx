import React from 'react'
import { Settings } from 'lucide-react'
import LogoMark from '../../LogoMark'

type Tab = 'routines' | 'plan'

interface Props {
  tab: Tab
  onTabChange: (t: Tab) => void
  onOpenMain: () => void
}

export default function TabStrip({ tab, onTabChange, onOpenMain }: Props): React.ReactElement {
  return (
    <div className="tab-strip">
      <div className="tab-strip__logo">
        <LogoMark size={20} />
        <span className="tab-strip__name">mypa</span>
      </div>

      <div className="tab-strip__tabs">
        <button
          className={`tab-btn${tab === 'routines' ? ' active' : ''}`}
          onClick={() => onTabChange('routines')}
        >
          Routines
        </button>
        <button
          className={`tab-btn${tab === 'plan' ? ' active' : ''}`}
          onClick={() => onTabChange('plan')}
        >
          Plan
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
