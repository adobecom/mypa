import React, { useState, useEffect } from 'react'
import { X } from 'lucide-react'
import type { Routine, RoutineAction, McpServerStatus, RoutineSetupDraft } from '@shared/types'
import { type Frequency, HOURS, buildCron, parseCron, formatHour, describeCron } from './cronUtils'

type FormData = Omit<Routine, 'id' | 'created_at'>

interface Props {
  initial?: Routine
  setupDraft?: RoutineSetupDraft
  onSave: (data: FormData) => Promise<void>
  onCancel: () => void
}

const DEFAULT_PROMPT = `Summarize the most important items that need my attention.
Be concise. Highlight anything urgent or time-sensitive.
Propose 2-3 specific follow-up actions I can take.`

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

function ScheduleBuilder({ cron, onChange }: { cron: string; onChange: (v: string) => void }) {
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

export default function RoutineForm({ initial, setupDraft, onSave, onCancel }: Props): React.ReactElement {
  const [name, setName] = useState(initial?.name ?? setupDraft?.name ?? '')
  const [cron, setCron] = useState(initial?.cron ?? setupDraft?.cron ?? '0 9 * * 1-5')
  const [prompt, setPrompt] = useState(initial?.prompt ?? setupDraft?.prompt ?? DEFAULT_PROMPT)
  const [enabled, setEnabled] = useState(initial?.enabled ?? true)
  const [actions, setActions] = useState<RoutineAction[]>(initial?.actions ?? setupDraft?.actions ?? [])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [serverStatus, setServerStatus] = useState<McpServerStatus[]>([])

  useEffect(() => {
    window.electron.config.getMcpStatus().then(setServerStatus)
  }, [])

  const handleAddAction = () => {
    setActions((prev) => [...prev, { server: '', tool: '', params: {} }])
  }

  const handleUpdateAction = (i: number, field: keyof RoutineAction, value: any) => {
    setActions((prev) => prev.map((a, idx) => (idx === i ? { ...a, [field]: value } : a)))
  }

  const handleRemoveAction = (i: number) => {
    setActions((prev) => prev.filter((_, idx) => idx !== i))
  }

  const handleSave = async () => {
    if (!name.trim()) { setError('Name is required'); return }
    if (!cron.trim()) { setError('Schedule is required'); return }
    setError('')
    setSaving(true)
    try {
      await onSave({ name, cron, prompt, enabled, actions })
    } catch (err: any) {
      setError(err?.message ?? 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <div className="page-header">
        <div className="page-title">{initial ? 'Edit routine' : 'New routine'}</div>
      </div>

      {setupDraft && !initial && (
        <div className="alert alert--success" style={{ marginBottom: 14 }}>
          AI suggested a name, actions, and digest prompt based on your description. Review and adjust before saving.
        </div>
      )}
      {error && <div className="alert alert--error">{error}</div>}

      <div className="card">
        <div className="form-group">
          <label className="form-label">Name</label>
          <input
            className="form-input"
            type="text"
            placeholder="e.g. Morning PR sweep"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="form-group">
          <label className="form-label">Schedule</label>
          <ScheduleBuilder cron={cron} onChange={setCron} />
        </div>

        <div className="form-group">
          <label className="form-label">Enabled</label>
          <label className="toggle">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <span className="toggle__track" />
          </label>
        </div>
      </div>

      <div className="card">
        <div className="card__header">
          <div>
            <div className="card__title">MCP Actions</div>
            <div className="card__subtitle">Tool calls to run when this routine fires</div>
          </div>
          <button className="btn btn--ghost btn--sm" onClick={handleAddAction}>
            + Add action
          </button>
        </div>

        {serverStatus.filter((s) => s.connected).length === 0 && (
          <div style={{ color: 'var(--text-muted)', fontSize: 12, padding: '8px 0' }}>
            No connected MCP servers. Add servers in Settings first.
          </div>
        )}

        {actions.map((action, i) => {
          const connectedServers = serverStatus.filter((s) => s.connected)
          const selectedServer = serverStatus.find((s) => s.name === action.server)
          const availableTools = selectedServer?.tools ?? []
          const selectedTool = availableTools.find((t) => t.name === action.tool)

          return (
            <div
              key={i}
              style={{
                background: 'var(--bg-elevated)',
                borderRadius: 'var(--radius-md)',
                padding: '10px 12px',
                marginBottom: 8
              }}
            >
              <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
                <select
                  className="form-select"
                  style={{ flex: 1 }}
                  value={action.server}
                  onChange={(e) => {
                    handleUpdateAction(i, 'server', e.target.value)
                    handleUpdateAction(i, 'tool', '')
                  }}
                >
                  <option value="">— Server —</option>
                  {connectedServers.map((s) => (
                    <option key={s.name} value={s.name}>{s.name}</option>
                  ))}
                </select>
                <select
                  className="form-select"
                  style={{ flex: 2 }}
                  value={action.tool}
                  disabled={!action.server || availableTools.length === 0}
                  onChange={(e) => handleUpdateAction(i, 'tool', e.target.value)}
                >
                  <option value="">— Tool —</option>
                  {availableTools.map((t) => (
                    <option key={t.name} value={t.name}>{t.name}</option>
                  ))}
                </select>
                <button className="btn btn--danger btn--sm" onClick={() => handleRemoveAction(i)}>
                  <X size={12} />
                </button>
              </div>
              {selectedTool?.description && (
                <div className="form-hint" style={{ marginBottom: 6 }}>{selectedTool.description}</div>
              )}
              <textarea
                className="form-textarea form-input--mono"
                rows={2}
                placeholder='Parameters as JSON (e.g. {"repo": "org/repo", "state": "open"})'
                value={JSON.stringify(action.params, null, 2)}
                onChange={(e) => {
                  try {
                    handleUpdateAction(i, 'params', JSON.parse(e.target.value))
                  } catch {}
                }}
                style={{ minHeight: 60, fontSize: 11 }}
              />
            </div>
          )
        })}
      </div>

      <div className="card">
        <div className="card__header">
          <div className="card__title">Digest prompt</div>
        </div>
        <textarea
          className="form-textarea"
          rows={4}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Instructions for Claude when digesting the MCP output…"
        />
      </div>

      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
        <button className="btn btn--ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button className="btn btn--primary" onClick={handleSave} disabled={saving || !name.trim()}>
          {saving ? 'Saving…' : initial ? 'Save changes' : 'Create routine'}
        </button>
      </div>
    </div>
  )
}
