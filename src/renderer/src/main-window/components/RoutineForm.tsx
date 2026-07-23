import React, { useState, useEffect } from 'react'
import { X } from 'lucide-react'
import type { Routine, RoutineAction, McpServerStatus, RoutineSetupDraft } from '@shared/types'
import { ScheduleBuilder } from './ScheduleBuilder'

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
            <div className="card__subtitle">
              Write-style actions (post, create, send…) run exactly as configured every time.
              Read-style actions are only a hint for the instructions below — the agent decides
              which read tools to call and how many times based on what it actually finds.
            </div>
          </div>
          <button className="btn btn--ghost btn--sm" style={{ flexShrink: 0, whiteSpace: 'nowrap' }} onClick={handleAddAction}>
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
          <div>
            <div className="card__title">Instructions</div>
            <div className="card__subtitle">
              What this routine should gather and report — spell out multi-step logic here
              (e.g. "for each open PR, fetch its CI status and changed files"), since this is
              what the agent uses to decide which tools to call, not just how to summarize.
            </div>
          </div>
        </div>
        <textarea
          className="form-textarea"
          rows={4}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="What should this routine gather and report each time it runs?"
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
