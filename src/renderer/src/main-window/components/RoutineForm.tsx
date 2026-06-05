import React, { useState, useEffect } from 'react'
import { X } from 'lucide-react'
import type { Routine, RoutineAction, McpServerStatus, RoutineSetupDraft } from '@shared/types'
import { type Frequency, WEEKDAYS, HOURS, buildCron, parseCron, formatHour } from './cronUtils'

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

function ScheduleBuilder({ cron, onChange }: { cron: string; onChange: (v: string) => void }) {
  const parsed = parseCron(cron)
  const [freq, setFreq] = useState<Frequency>(parsed?.freq ?? 'weekdays')
  const [hour, setHour] = useState(parsed?.hour ?? 9)
  const [weekday, setWeekday] = useState(parsed?.weekday ?? 1)
  const [custom, setCustom] = useState(!parsed)
  const [customValue, setCustomValue] = useState(cron)

  const update = (f: Frequency, h: number, w: number) => {
    setFreq(f)
    setHour(h)
    setWeekday(w)
    onChange(buildCron(f, h, w))
  }

  const showDay = freq === 'weekly'
  const showTime = freq !== 'hourly' && freq !== 'twice-daily'

  if (custom) {
    return (
      <div>
        <input
          className="form-input form-input--mono"
          type="text"
          value={customValue}
          onChange={(e) => {
            setCustomValue(e.target.value)
            onChange(e.target.value)
          }}
          placeholder="0 9 * * 1-5"
        />
        <div className="form-hint" style={{ marginTop: 4 }}>
          Cron expression (minute hour day month weekday)
          {' · '}
          <button
            type="button"
            style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent)', cursor: 'pointer', fontSize: 'inherit' }}
            onClick={() => {
              const p = parseCron(customValue)
              if (p) { setFreq(p.freq); setHour(p.hour); setWeekday(p.weekday) }
              setCustom(false)
            }}
          >
            Use builder
          </button>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <select
          className="form-select"
          value={freq}
          onChange={(e) => update(e.target.value as Frequency, hour, weekday)}
        >
          <option value="hourly">Every hour</option>
          <option value="daily">Every day</option>
          <option value="weekdays">Every weekday</option>
          <option value="weekly">Every week</option>
          <option value="twice-daily">Twice daily</option>
        </select>

        {showDay && (
          <select
            className="form-select"
            value={weekday}
            onChange={(e) => update(freq, hour, parseInt(e.target.value, 10))}
          >
            {WEEKDAYS.map((d) => (
              <option key={d.value} value={d.value}>{d.label}</option>
            ))}
          </select>
        )}

        {showTime && (
          <>
            <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>at</span>
            <select
              className="form-select"
              value={hour}
              onChange={(e) => update(freq, parseInt(e.target.value, 10), weekday)}
            >
              {HOURS.map((h) => (
                <option key={h} value={h}>{formatHour(h)}</option>
              ))}
            </select>
          </>
        )}

        {freq === 'twice-daily' && (
          <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>9 AM & 5 PM</span>
        )}
      </div>

      <div className="form-hint" style={{ marginTop: 4 }}>
        <button
          type="button"
          style={{ background: 'none', border: 'none', padding: 0, color: 'var(--text-muted)', cursor: 'pointer', fontSize: 'inherit', textDecoration: 'underline' }}
          onClick={() => { setCustomValue(buildCron(freq, hour, weekday)); setCustom(true) }}
        >
          Custom schedule
        </button>
      </div>
    </div>
  )
}

export default function RoutineForm({ initial, setupDraft, onSave, onCancel }: Props): React.ReactElement {
  const [name, setName] = useState(initial?.name ?? setupDraft?.name ?? '')
  const [cron, setCron] = useState(initial?.cron ?? '0 9 * * 1-5')
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
