import React, { useState, useEffect, useCallback } from 'react'
import { BarChart3 } from 'lucide-react'
import type { UsageRange, UsageSummary, UsageDailyPoint, UsageBreakdownRow, UsageEvent } from '../../../../../../shared/types'

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function fmtCost(usd: number): string {
  if (usd === 0) return '$0.00'
  if (usd < 0.01) return `$${usd.toFixed(5)}`
  if (usd < 1) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}

function fmtCostShort(usd: number): string {
  if (usd === 0) return '$0.00'
  if (usd < 0.001) return '<$0.001'
  return `$${usd.toFixed(3)}`
}

function fmtRelTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function humanizeSource(s: string): string {
  const map: Record<string, string> = {
    plan_draft: 'Plan draft',
    routine_digest: 'Routine digest',
    routine_setup: 'Routine setup',
    routine_chat: 'Routine chat',
    plan_chat: 'Plan chat',
    inference: 'Ambient inference',
    memory: 'Memory distillation',
    chat: 'Chat',
    other: 'Other'
  }
  return map[s] ?? s
}

// ─── Stat card ────────────────────────────────────────────────────────────────

interface StatCardProps {
  label: string
  value: string
  sub?: string
}

function StatCard({ label, value, sub }: StatCardProps): React.ReactElement {
  return (
    <div className="card stat-card">
      <div className="stat-card__label">{label}</div>
      <div className="stat-card__value">{value}</div>
      {sub && <div className="stat-card__sub">{sub}</div>}
    </div>
  )
}

// ─── SVG Bar chart ────────────────────────────────────────────────────────────

interface BarChartProps {
  data: UsageDailyPoint[]
  metric: 'cost' | 'tokens'
}

function BarChart({ data, metric }: BarChartProps): React.ReactElement {
  const W = 580
  const H = 110
  const PAD_L = 0
  const PAD_B = 20
  const barAreaH = H - PAD_B

  if (data.length === 0) {
    return (
      <div className="empty-state" style={{ padding: '24px 0' }}>
        <div className="empty-state__icon"><BarChart3 size={24} strokeWidth={1.5} /></div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>No usage data for this period</div>
      </div>
    )
  }

  const values = data.map((d) =>
    metric === 'cost' ? d.cost : d.input_tokens + d.output_tokens
  )
  const maxVal = Math.max(...values, 0.000001)
  const barW = Math.max(2, Math.floor((W - PAD_L) / data.length) - 2)

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 110, display: 'block', overflow: 'visible' }}>
      {data.map((d, i) => {
        const val = values[i]
        const bh = Math.max(2, (val / maxVal) * barAreaH)
        const x = PAD_L + i * ((W - PAD_L) / data.length)
        const y = barAreaH - bh

        // Label: show day-of-month for first of month or first/last item
        const date = new Date(d.day)
        const isFirst = i === 0
        const isMonthStart = date.getDate() === 1
        const showLabel = isFirst || isMonthStart || i === data.length - 1

        const tooltip = `${d.day}\n${metric === 'cost' ? fmtCost(d.cost) : fmtTokens(d.input_tokens + d.output_tokens)} · ${d.calls} call${d.calls !== 1 ? 's' : ''}`

        return (
          <g key={d.day}>
            <rect
              x={x}
              y={y}
              width={barW}
              height={bh}
              rx={2}
              fill="var(--accent)"
              opacity={val === 0 ? 0.2 : 0.85}
            >
              <title>{tooltip}</title>
            </rect>
            {showLabel && (
              <text
                x={x + barW / 2}
                y={H - 4}
                textAnchor="middle"
                fontSize={9}
                fill="var(--text-muted)"
              >
                {date.getDate()}
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}

// ─── Breakdown section ────────────────────────────────────────────────────────

interface BreakdownSectionProps {
  title: string
  rows: UsageBreakdownRow[]
  labelFn?: (key: string) => string
}

function BreakdownSection({ title, rows, labelFn }: BreakdownSectionProps): React.ReactElement {
  const maxCost = Math.max(...rows.map((r) => r.cost), 0.000001)
  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="card__header" style={{ padding: '14px 16px 10px' }}>
        <div className="card__title">{title}</div>
      </div>
      {rows.length === 0 ? (
        <div style={{ padding: '16px', color: 'var(--text-muted)', fontSize: 12 }}>
          No data for this period.
        </div>
      ) : (
        rows.map((row) => (
          <div key={row.key} className="breakdown-row">
            <div className="breakdown-row__label">{labelFn ? labelFn(row.key) : row.key}</div>
            <div className="breakdown-row__bar-wrap">
              <div
                className="breakdown-row__bar"
                style={{ width: `${(row.cost / maxCost) * 100}%` }}
              />
            </div>
            <span className="tag tag--neutral breakdown-row__calls">{row.calls}</span>
            <div className="breakdown-row__cost">{fmtCostShort(row.cost)}</div>
          </div>
        ))
      )}
    </div>
  )
}

// ─── Recent calls ─────────────────────────────────────────────────────────────

interface RecentCallsProps {
  events: UsageEvent[]
}

function RecentCalls({ events }: RecentCallsProps): React.ReactElement {
  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="card__header" style={{ padding: '14px 16px 10px' }}>
        <div className="card__title">Recent calls</div>
      </div>
      {events.length === 0 ? (
        <div style={{ padding: '16px', color: 'var(--text-muted)', fontSize: 12 }}>
          No calls recorded yet.
        </div>
      ) : (
        events.map((e) => (
          <div key={e.id} className="usage-call-row">
            <div className="usage-call-row__source">{humanizeSource(e.source)}</div>
            <span className="tag tag--neutral" style={{ fontSize: 10 }}>
              {e.model ? e.model.split('-').slice(0, 2).join('-') : '—'}
            </span>
            <div className="usage-call-row__tokens">
              {fmtTokens(e.input_tokens)}↑ {fmtTokens(e.output_tokens)}↓
            </div>
            <div className="usage-call-row__cost">{fmtCost(e.cost_usd)}</div>
            <div className="usage-call-row__time">{fmtRelTime(e.created_at)}</div>
          </div>
        ))
      )}
    </div>
  )
}

// ─── Main dashboard ───────────────────────────────────────────────────────────

const RANGES: { id: UsageRange; label: string }[] = [
  { id: '7d', label: '7d' },
  { id: '30d', label: '30d' },
  { id: '90d', label: '90d' },
  { id: 'all', label: 'All' }
]

export default function UsageDashboard(): React.ReactElement {
  const [range, setRange] = useState<UsageRange>('30d')
  const [chartMetric, setChartMetric] = useState<'cost' | 'tokens'>('cost')
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [daily, setDaily] = useState<UsageDailyPoint[]>([])
  const [bySource, setBySource] = useState<UsageBreakdownRow[]>([])
  const [byModel, setByModel] = useState<UsageBreakdownRow[]>([])
  const [recent, setRecent] = useState<UsageEvent[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async (r: UsageRange) => {
    setLoading(true)
    const [sum, day, src, mdl, rec] = await Promise.all([
      window.electron.usage.getSummary(r),
      window.electron.usage.getDaily(r),
      window.electron.usage.getBySource(r),
      window.electron.usage.getByModel(r),
      window.electron.usage.getRecent(30, r)
    ])
    setSummary(sum)
    setDaily(day)
    setBySource(src)
    setByModel(mdl)
    setRecent(rec)
    setLoading(false)
  }, [])

  useEffect(() => { load(range) }, [range, load])

  const totalTokens = summary
    ? summary.total_input + summary.total_output + summary.total_cache_creation + summary.total_cache_read
    : 0
  const avgCost = summary && summary.call_count > 0
    ? summary.total_cost / summary.call_count
    : 0

  return (
    <div>
      {/* ── Header ── */}
      <div className="page-header" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div>
          <div className="page-title">Usage</div>
          <div className="page-subtitle">Token usage &amp; estimated cost · powered by the Claude CLI</div>
        </div>
        <div className="segmented" style={{ marginTop: 2 }}>
          {RANGES.map((r) => (
            <button
              key={r.id}
              className={`segmented__btn${range === r.id ? ' active' : ''}`}
              onClick={() => setRange(r.id)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {loading && !summary ? (
        <div style={{ padding: 24, color: 'var(--text-muted)' }}>Loading…</div>
      ) : (
        <>
          {/* ── Stat grid ── */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginBottom: 16 }}>
            <StatCard
              label="Est. cost"
              value={fmtCost(summary?.total_cost ?? 0)}
              sub="as reported by Claude CLI"
            />
            <StatCard
              label="Total tokens"
              value={fmtTokens(totalTokens)}
              sub={`${fmtTokens(summary?.total_input ?? 0)} in · ${fmtTokens(summary?.total_output ?? 0)} out`}
            />
            <StatCard
              label="Total calls"
              value={String(summary?.call_count ?? 0)}
            />
            <StatCard
              label="Avg cost / call"
              value={fmtCost(avgCost)}
            />
          </div>

          {/* ── Daily chart ── */}
          <div className="card usage-chart" style={{ marginBottom: 16 }}>
            <div className="usage-chart__header">
              <div className="usage-chart__title">Usage over time</div>
              <div className="segmented">
                <button
                  className={`segmented__btn${chartMetric === 'cost' ? ' active' : ''}`}
                  onClick={() => setChartMetric('cost')}
                >
                  Cost
                </button>
                <button
                  className={`segmented__btn${chartMetric === 'tokens' ? ' active' : ''}`}
                  onClick={() => setChartMetric('tokens')}
                >
                  Tokens
                </button>
              </div>
            </div>
            <BarChart data={daily} metric={chartMetric} />
          </div>

          {/* ── By feature + By model (side by side) ── */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
            <BreakdownSection
              title="By feature"
              rows={bySource}
              labelFn={humanizeSource}
            />
            <BreakdownSection
              title="By model"
              rows={byModel}
            />
          </div>

          {/* ── Recent calls ── */}
          <RecentCalls events={recent} />

          {/* ── Footer note ── */}
          <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 12, textAlign: 'center' }}>
            Cost estimates are provided by the Claude CLI and may differ from your Anthropic billing. Usage is recorded from the moment mypa was installed.
          </p>
        </>
      )}
    </div>
  )
}
