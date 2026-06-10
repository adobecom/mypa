import React, { useState } from 'react'
import { Sparkles, X } from 'lucide-react'
import type { PlanDraft, PlanItemTiming } from '../../../../../../shared/types'
import { useAutoGrowTextarea } from '@renderer/hooks/useAutoGrowTextarea'

const TIMINGS: { value: PlanItemTiming; label: string }[] = [
  { value: 'now', label: 'Now' },
  { value: 'morning', label: 'Morning' },
  { value: 'afternoon', label: 'Afternoon' },
  { value: 'evening', label: 'Evening' },
  { value: 'anytime', label: 'Anytime' }
]

interface Props {
  draft: PlanDraft
  onConfirm: (d: PlanDraft) => void
  onDismiss: () => void
}

export default function PlanReviewCard({ draft, onConfirm, onDismiss }: Props): React.ReactElement {
  const [title, setTitle] = useState(draft.title)
  const [detail, setDetail] = useState(draft.detail)
  const [timing, setTiming] = useState<PlanItemTiming>(draft.timing)
  const [saving, setSaving] = useState(false)
  const detailRef = useAutoGrowTextarea(detail)

  const handleConfirm = async () => {
    if (!title.trim()) return
    setSaving(true)
    try {
      await onConfirm({ ...draft, title, detail, timing })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="plan-review-card">
      <div className="plan-review-card__header">
        <span className="plan-review-card__label"><Sparkles size={10} /> Claude suggests</span>
        <button className="plan-review-card__dismiss" onClick={onDismiss}>
          <X size={14} />
        </button>
      </div>

      <div className="plan-review-card__body">
        <div className="review-field">
          <div className="review-field__label">Title</div>
          <input
            className="review-field__input"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What to do"
            autoFocus
          />
        </div>

        {(detail || draft.detail) && (
          <div className="review-field">
            <div className="review-field__label">Detail</div>
            <textarea
              ref={detailRef}
              className="review-field__input"
              rows={1}
              value={detail}
              onChange={(e) => setDetail(e.target.value)}
              placeholder="Additional context (optional)"
            />
          </div>
        )}

        <div className="review-field">
          <div className="review-field__label">When</div>
          <select
            className="review-field__select"
            value={timing}
            onChange={(e) => setTiming(e.target.value as PlanItemTiming)}
          >
            {TIMINGS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="plan-review-card__footer">
        <button className="btn btn--ghost" onClick={onDismiss} disabled={saving}>
          Dismiss
        </button>
        <button className="btn btn--primary" onClick={handleConfirm} disabled={!title.trim() || saving}>
          {saving ? 'Saving…' : 'Add to plan'}
        </button>
      </div>
    </div>
  )
}
