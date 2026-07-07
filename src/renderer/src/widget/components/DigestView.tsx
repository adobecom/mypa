import React, { useState, useEffect, useRef } from 'react'
import { Sparkles } from 'lucide-react'
import type { AmbientDigest, DigestSlot } from '@shared/types'
import MarkdownText from '@renderer/components/MarkdownText'

const SLOTS: DigestSlot[] = ['morning', 'midday', 'eod']
const SLOT_LABELS: Record<DigestSlot, string> = { morning: 'Morning', midday: 'Midday', eod: 'End of Day' }

export default function DigestView(): React.ReactElement {
  const [slot, setSlot] = useState<DigestSlot>(currentSlot())
  const [digest, setDigest] = useState<AmbientDigest | null>(null)
  const [loading, setLoading] = useState(false)

  // Keep a ref to the current slot so the push-event handler always reads the latest
  // value without needing to re-subscribe every time the user switches segments.
  const slotRef = useRef(slot)
  useEffect(() => { slotRef.current = slot }, [slot])

  const api = window.electron

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api.ambient.getDigest(slot)
      .then((d) => { if (!cancelled) setDigest(d as AmbientDigest) })
      .catch(console.error)
      .finally(() => { if (!cancelled) setLoading(false) })
    // Cleanup: mark this fetch stale if slot changes before it resolves.
    // Intentionally do NOT clear digest here so previous slot's content
    // stays visible under the "Loading…" indicator until the new one lands.
    return () => { cancelled = true }
  }, [slot])

  // Subscribe once; use slotRef so the handler always compares against the current slot
  useEffect(() => {
    const unsub = api.on('ambient:digest-ready', (s) => {
      if (s === slotRef.current) {
        api.ambient.getDigest(slotRef.current).then((d) => setDigest(d as AmbientDigest))
      }
    })
    return unsub
  }, [])

  return (
    <div className="plan-review-card" style={{ margin: '8px 10px' }}>
      <div className="plan-review-card__header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Sparkles size={13} color="var(--accent-text)" />
          <span className="plan-review-card__title">Daily Digest</span>
        </div>

        {/* Segmented slot selector */}
        <div style={{ display: 'flex', background: 'var(--bg-elevated)', borderRadius: 8, padding: 2, gap: 2 }}>
          {SLOTS.map((s) => (
            <button
              key={s}
              onClick={() => setSlot(s)}
              style={{
                padding: '3px 8px',
                borderRadius: 6,
                border: 'none',
                cursor: 'pointer',
                fontSize: 11,
                fontFamily: 'var(--font-sans)',
                fontWeight: slot === s ? 600 : 400,
                background: slot === s ? 'var(--bg-overlay)' : 'transparent',
                color: slot === s ? 'var(--text-primary)' : 'var(--text-muted)',
                transition: 'background var(--transition), color var(--transition)'
              }}
            >
              {SLOT_LABELS[s]}
            </button>
          ))}
        </div>
      </div>

      <div className="plan-review-card__body">
        {loading && (
          <div style={{ color: 'var(--text-muted)', fontSize: 12, padding: '8px 0' }}>Loading…</div>
        )}

        {!loading && digest && (
          <>
            {digest.section.did.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                <div className="section-subheader">Did</div>
                {digest.section.did.map((item, i) => (
                  <div key={i} style={{ display: 'flex', gap: 4, alignItems: 'flex-start', padding: '2px 0', fontSize: 12, color: 'var(--text-secondary)' }}>
                    <span style={{ fontSize: 11, lineHeight: '18px', flexShrink: 0 }}>·</span>
                    <MarkdownText>{item}</MarkdownText>
                  </div>
                ))}
              </div>
            )}

            {digest.section.watching.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                <div className="section-subheader">Watching</div>
                {digest.section.watching.map((item, i) => (
                  <div key={i} style={{ display: 'flex', gap: 4, alignItems: 'flex-start', padding: '2px 0', fontSize: 12, color: 'var(--text-secondary)' }}>
                    <span style={{ fontSize: 11, lineHeight: '18px', flexShrink: 0 }}>·</span>
                    <MarkdownText>{item}</MarkdownText>
                  </div>
                ))}
              </div>
            )}

            {digest.section.decisions.length > 0 && (
              <div>
                <div className="section-subheader">Needs a decision</div>
                <div style={{ fontSize: 12, color: 'var(--yellow)', padding: '2px 0' }}>
                  {digest.section.decisions.length} item{digest.section.decisions.length > 1 ? 's' : ''} waiting for you
                </div>
              </div>
            )}

            {digest.section.did.length === 0 && digest.section.watching.length === 0 && digest.section.decisions.length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '4px 0' }}>Nothing to report yet for {SLOT_LABELS[slot].toLowerCase()}.</div>
            )}
          </>
        )}

        {!loading && !digest && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '4px 0' }}>No digest available yet.</div>
        )}
      </div>
    </div>
  )
}

function currentSlot(): DigestSlot {
  const h = new Date().getHours()
  if (h < 11) return 'morning'
  if (h < 15) return 'midday'
  return 'eod'
}
