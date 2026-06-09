import React, { useState } from 'react'
import { type Frequency, HOURS, buildCron, parseCron, formatHour, describeCron } from './cronUtils'

const FREQ_OPTIONS: { value: Frequency; label: string }[] = [
  { value: 'hourly', label: 'Hourly' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekdays', label: 'Weekdays' },
  { value: 'weekly', label: 'Weekly' },
]

const DAY_LABELS = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 0, label: 'Sun' },
]

const WIDGET_CONTAINER: React.CSSProperties = {
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-md)',
  padding: '14px 16px',
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
}

export function ScheduleBuilder({ cron, onChange }: { cron: string; onChange: (v: string) => void }): React.ReactElement {
  const parsed = parseCron(cron)
  const [freq, setFreq] = useState<Frequency>(parsed?.freq ?? 'weekdays')
  const [hours, setHours] = useState<number[]>(parsed?.hours ?? [9])
  const [weekday, setWeekday] = useState(parsed?.weekday ?? 1)
  const [custom, setCustom] = useState(!parsed)
  const [customValue, setCustomValue] = useState(cron)

  const update = (f: Frequency, h: number[], w: number) => {
    setFreq(f)
    setHours(h)
    setWeekday(w)
    onChange(buildCron(f, h, w))
  }

  if (custom) {
    return (
      <div style={WIDGET_CONTAINER}>
        <input
          className="form-input form-input--mono"
          type="text"
          value={customValue}
          onChange={(e) => { setCustomValue(e.target.value); onChange(e.target.value) }}
          placeholder="0 9 * * 1-5"
          style={{ marginBottom: 0 }}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="form-hint" style={{ marginTop: 0 }}>minute · hour · day · month · weekday</span>
          <button
            type="button"
            style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent)', cursor: 'pointer', fontSize: 12, fontFamily: 'var(--font-sans)' }}
            onClick={() => {
              const p = parseCron(customValue)
              if (p) { setFreq(p.freq); setHours(p.hours); setWeekday(p.weekday) }
              setCustom(false)
            }}
          >
            ← Use builder
          </button>
        </div>
      </div>
    )
  }

  const showDay = freq === 'weekly'
  const showTime = freq !== 'hourly'
  const summary = describeCron(buildCron(freq, hours, weekday))

  return (
    <div style={WIDGET_CONTAINER}>

      {/* Frequency segmented control */}
      <div style={{
        display: 'flex',
        background: 'var(--bg-base)',
        border: '1px solid var(--border-muted)',
        borderRadius: 'var(--radius-sm)',
        padding: 3,
        gap: 2,
      }}>
        {FREQ_OPTIONS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => update(f.value, f.value === 'hourly' ? [9] : hours, weekday)}
            style={{
              flex: 1,
              padding: '5px 0',
              borderRadius: 4,
              fontSize: 12,
              fontWeight: freq === f.value ? 600 : 400,
              fontFamily: 'var(--font-sans)',
              background: freq === f.value ? 'var(--accent)' : 'transparent',
              color: freq === f.value ? '#fff' : 'var(--text-muted)',
              border: 'none',
              cursor: 'pointer',
              transition: 'background var(--transition), color var(--transition)',
            }}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Day-of-week selector (weekly only) */}
      {showDay && (
        <div>
          <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-muted)', marginBottom: 6, letterSpacing: '0.03em' }}>
            Day
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            {DAY_LABELS.map((d) => {
              const active = weekday === d.value
              return (
                <button
                  key={d.value}
                  type="button"
                  onClick={() => update(freq, hours, d.value)}
                  style={{
                    flex: 1,
                    padding: '5px 0',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: 11,
                    fontWeight: active ? 600 : 400,
                    fontFamily: 'var(--font-sans)',
                    background: active ? 'var(--accent-muted)' : 'transparent',
                    color: active ? 'var(--accent-text)' : 'var(--text-muted)',
                    border: `1px solid ${active ? 'rgba(109,106,255,0.35)' : 'var(--border-muted)'}`,
                    cursor: 'pointer',
                    transition: 'all var(--transition)',
                  }}
                >
                  {d.label}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Time grid — 6 columns × 3 rows */}
      {showTime && (
        <div>
          <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-muted)', marginBottom: 6, letterSpacing: '0.03em' }}>
            Time {hours.length > 1 ? `· ${hours.length} selected` : ''}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 4 }}>
            {HOURS.map((h) => {
              const selected = hours.includes(h)
              return (
                <button
                  key={h}
                  type="button"
                  onClick={() => {
                    const next = selected
                      ? hours.filter((x) => x !== h)
                      : [...hours, h].sort((a, b) => a - b)
                    if (next.length === 0) return
                    update(freq, next, weekday)
                  }}
                  style={{
                    padding: '5px 0',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: 11,
                    fontWeight: selected ? 600 : 400,
                    fontFamily: 'var(--font-sans)',
                    background: selected ? 'var(--accent)' : 'transparent',
                    color: selected ? '#fff' : 'var(--text-secondary)',
                    border: `1px solid ${selected ? 'var(--accent)' : 'var(--border-muted)'}`,
                    cursor: 'pointer',
                    transition: 'all var(--transition)',
                    textAlign: 'center',
                    boxShadow: selected ? '0 0 8px rgba(109,106,255,0.3)' : 'none',
                  }}
                >
                  {formatHour(h)}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Summary + custom cron link */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{
          flex: 1,
          fontSize: 12,
          color: 'var(--accent-text)',
          background: 'var(--accent-muted)',
          border: '1px solid rgba(109,106,255,0.18)',
          borderRadius: 'var(--radius-sm)',
          padding: '5px 10px',
        }}>
          {summary}
        </div>
        <button
          type="button"
          style={{
            background: 'none',
            border: 'none',
            padding: 0,
            color: 'var(--text-muted)',
            cursor: 'pointer',
            fontSize: 11,
            fontFamily: 'var(--font-sans)',
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
          onClick={() => { setCustomValue(buildCron(freq, hours, weekday)); setCustom(true) }}
        >
          Custom cron ↗
        </button>
      </div>

    </div>
  )
}
