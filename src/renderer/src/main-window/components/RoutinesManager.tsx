import React, { useState, useEffect } from 'react'
import { Zap, Play } from 'lucide-react'
import RoutineForm from './RoutineForm'
import { describeCron } from './cronUtils'
import { useToast } from '../toast/ToastProvider'
import type { Routine, RoutineSetupDraft } from '@shared/types'

function RoutineAiSetup({
  onDraftReady,
  onSkip
}: {
  onDraftReady: (draft: RoutineSetupDraft) => void
  onSkip: () => void
}): React.ReactElement {
  const [intent, setIntent] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleGenerate = async () => {
    if (!intent.trim()) return
    setLoading(true)
    setError('')
    try {
      const draft = await window.electron.routines.generateSetup(intent.trim())
      onDraftReady(draft)
    } catch (err: any) {
      setError(err?.message ?? 'Failed to generate setup')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <div className="page-header">
        <div className="page-title">New routine</div>
      </div>
      <div className="card">
        <div className="card__header">
          <div>
            <div className="card__title">Set up with AI</div>
            <div className="card__subtitle">Describe what you want this routine to track or do</div>
          </div>
        </div>

        {error && <div className="alert alert--error">{error}</div>}

        <div className="form-group">
          <textarea
            className="form-textarea"
            rows={4}
            placeholder="e.g. Check my open GitHub PRs every morning and summarize any that need review or have failing CI"
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            disabled={loading}
            autoFocus
          />
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'space-between', alignItems: 'center' }}>
          <button className="btn btn--ghost btn--sm" onClick={onSkip} disabled={loading}>
            Set up manually instead
          </button>
          <button
            className="btn btn--primary"
            onClick={handleGenerate}
            disabled={loading || !intent.trim()}
          >
            {loading ? 'Thinking…' : 'Set up with AI →'}
          </button>
        </div>
      </div>
    </div>
  )
}

interface Props {
  editRoutineId?: string | null
  onEditHandled?: () => void
}

export default function RoutinesManager({ editRoutineId, onEditHandled }: Props): React.ReactElement {
  const [routines, setRoutines] = useState<Routine[]>([])
  const [showForm, setShowForm] = useState(false)
  const [showAiSetup, setShowAiSetup] = useState(false)
  const [setupDraft, setSetupDraft] = useState<RoutineSetupDraft | null>(null)
  const [editing, setEditing] = useState<Routine | null>(null)
  const [loading, setLoading] = useState(true)

  const api = window.electron
  const toast = useToast()

  useEffect(() => {
    api.routines.getAll().then((r) => { setRoutines(r); setLoading(false) })
  }, [])

  useEffect(() => {
    if (!editRoutineId || routines.length === 0) return
    const routine = routines.find((r) => r.id === editRoutineId)
    if (routine) {
      setEditing(routine)
      onEditHandled?.()
    }
  }, [editRoutineId, routines])

  const handleCreate = async (data: Omit<Routine, 'id' | 'created_at'>) => {
    try {
      const r = await api.routines.create(data)
      setRoutines((prev) => [...prev, r])
      setShowForm(false)
      toast.success(`Routine "${r.name}" created`)
    } catch (err: any) {
      toast.error('Failed to create routine', { message: err?.message })
    }
  }

  const handleUpdate = async (data: Omit<Routine, 'id' | 'created_at'>) => {
    if (!editing) return
    try {
      const r = await api.routines.update(editing.id, data)
      setRoutines((prev) => prev.map((x) => (x.id === r.id ? r : x)))
      setEditing(null)
      toast.success(`Routine "${r.name}" saved`)
    } catch (err: any) {
      toast.error('Failed to save routine', { message: err?.message })
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this routine?')) return
    const name = routines.find((r) => r.id === id)?.name ?? 'Routine'
    try {
      await api.routines.delete(id)
      setRoutines((prev) => prev.filter((r) => r.id !== id))
      toast.success(`"${name}" deleted`)
    } catch (err: any) {
      toast.error('Failed to delete routine', { message: err?.message })
    }
  }

  const handleToggle = async (r: Routine) => {
    try {
      const updated = await api.routines.update(r.id, { ...r, enabled: !r.enabled })
      setRoutines((prev) => prev.map((x) => (x.id === updated.id ? updated : x)))
    } catch (err: any) {
      toast.error('Failed to update routine', { message: err?.message })
    }
  }

  const handleRunNow = async (id: string) => {
    // Fire-and-forget: run-started / run-completed events will drive toasts via
    // the useRunToasts bridge in App.tsx. We only need error handling here for
    // the case where the IPC invoke itself fails (e.g. routine not found).
    try {
      await api.routines.runNow(id)
    } catch (err: any) {
      toast.error('Failed to start routine', { message: err?.message })
    }
  }

  if (showAiSetup) {
    return (
      <RoutineAiSetup
        onDraftReady={(draft) => {
          setSetupDraft(draft)
          setShowAiSetup(false)
          setShowForm(true)
        }}
        onSkip={() => {
          setSetupDraft(null)
          setShowAiSetup(false)
          setShowForm(true)
        }}
      />
    )
  }

  if (editing) {
    return (
      <div>
        <div className="page-header">
          <button className="btn btn--ghost btn--sm" onClick={() => setEditing(null)}>
            ← Back
          </button>
        </div>
        <RoutineForm
          initial={editing}
          onSave={handleUpdate}
          onCancel={() => setEditing(null)}
        />
      </div>
    )
  }

  if (showForm) {
    return (
      <div>
        <div className="page-header">
          <button className="btn btn--ghost btn--sm" onClick={() => { setShowForm(false); setSetupDraft(null); setShowAiSetup(true) }}>
            ← Back
          </button>
        </div>
        <RoutineForm
          setupDraft={setupDraft ?? undefined}
          onSave={handleCreate}
          onCancel={() => { setShowForm(false); setSetupDraft(null) }}
        />
      </div>
    )
  }

  return (
    <div>
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div className="page-title">Routines</div>
            <div className="page-subtitle">Scheduled jobs that check your tools and notify you</div>
          </div>
          <button className="btn btn--primary" onClick={() => setShowAiSetup(true)}>
            + New routine
          </button>
        </div>
      </div>

      {loading ? (
        <div style={{ padding: 24, color: 'var(--text-muted)' }}>Loading…</div>
      ) : routines.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-state__icon"><Zap size={24} strokeWidth={1.5} /></div>
            <h3>No routines yet</h3>
            <p>Create your first routine to start getting automated digests.</p>
            <button className="btn btn--primary" style={{ marginTop: 14 }} onClick={() => setShowAiSetup(true)}>
              Create routine
            </button>
          </div>
        </div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          {routines.map((r) => (
            <div key={r.id} className="routine-row">
              <div className="routine-row__name">{r.name}</div>
              <span className="routine-row__cron">{describeCron(r.cron)}</span>
              <span className={`routine-row__status routine-row__status--${r.enabled ? 'enabled' : 'disabled'}`}>
                {r.enabled ? 'active' : 'paused'}
              </span>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn btn--ghost btn--sm" onClick={() => handleRunNow(r.id)} title="Run now">
                  <Play size={11} />
                </button>
                <button className="btn btn--ghost btn--sm" onClick={() => handleToggle(r)}>
                  {r.enabled ? 'Pause' : 'Enable'}
                </button>
                <button className="btn btn--ghost btn--sm" onClick={() => setEditing(r)}>
                  Edit
                </button>
                <button className="btn btn--danger btn--sm" onClick={() => handleDelete(r.id)}>
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
