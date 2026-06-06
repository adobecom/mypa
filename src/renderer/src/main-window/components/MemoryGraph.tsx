import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import ForceGraph2D from 'react-force-graph-2d'
import type { ForceGraphMethods } from 'react-force-graph-2d'
import { X, Trash2, Archive, RefreshCw, ChevronRight, Maximize2 } from 'lucide-react'
import type { GraphNode, GraphEdge, Memory, NodeSignalLink, NodeType, EdgeRel } from '@shared/types'

// ─── Palette ──────────────────────────────────────────────────────────────────

const TYPE_COLORS: Record<NodeType, string> = {
  person: '#6d6aff',
  project: '#4ade9e',
  task: '#f59e60',
  decision: '#f87b7b'
}
const TYPE_ORDER: NodeType[] = ['person', 'project', 'task', 'decision']

// ─── Force-graph data types ───────────────────────────────────────────────────

interface GNode {
  id: string
  type: NodeType
  label: string
  weight: number
  degree: number
  x?: number
  y?: number
}

interface GLink {
  id: string
  source: string | GNode
  target: string | GNode
  rel: EdgeRel
}

const BLOCKED = (r: EdgeRel) => r === 'blocked_by' || r === 'waiting_for'

function linkNodeId(n: string | GNode): string {
  return typeof n === 'object' ? n.id : n
}

function getNodeRadius(n: GNode): number {
  return 3 + Math.sqrt(n.degree) * 1.8 + n.weight * 1.5
}

function buildGraph(nodes: GraphNode[], edges: GraphEdge[]): { nodes: GNode[]; links: GLink[] } {
  const degree = new Map<string, number>()
  edges.forEach((e) => {
    degree.set(e.src_id, (degree.get(e.src_id) ?? 0) + 1)
    degree.set(e.dst_id, (degree.get(e.dst_id) ?? 0) + 1)
  })
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.type,
      label: n.label,
      weight: n.weight,
      degree: degree.get(n.id) ?? 0
    })),
    links: edges.map((e) => ({ id: e.id, source: e.src_id, target: e.dst_id, rel: e.rel }))
  }
}

// ─── Detail panel ─────────────────────────────────────────────────────────────

interface NodeDetail {
  node: GraphNode
  edges: GraphEdge[]
  memories: Memory[]
  timeline: NodeSignalLink[]
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function RelLabel({ rel }: { rel: EdgeRel }) {
  const COLORS: Record<EdgeRel, string> = {
    working_on: '#4ade9e',
    blocked_by: '#f87b7b',
    depends_on: '#f59e60',
    mentioned_in: 'rgba(180,195,230,0.6)',
    assigned_to: '#6d6aff',
    waiting_for: '#f87b7b',
    deferred: 'rgba(140,160,200,0.5)'
  }
  return (
    <span
      style={{
        fontSize: 9,
        fontWeight: 600,
        letterSpacing: '0.05em',
        textTransform: 'uppercase',
        color: COLORS[rel] ?? 'rgba(180,195,230,0.6)',
        background: `${COLORS[rel] ?? '#888'}18`,
        borderRadius: 4,
        padding: '1px 5px'
      }}
    >
      {rel.replace(/_/g, ' ')}
    </span>
  )
}

interface PanelProps {
  detail: NodeDetail
  rawNodes: GraphNode[]
  onClose(): void
  onDeleteNode(id: string): Promise<void>
  onDeleteMemory(id: string): Promise<void>
  onArchiveMemory(id: string): Promise<void>
}

const SECTION: React.CSSProperties = {
  borderTop: '1px solid rgba(255,255,255,0.06)',
  padding: '12px 16px'
}

function NodeDetailPanel({
  detail,
  rawNodes,
  onClose,
  onDeleteNode,
  onDeleteMemory,
  onArchiveMemory
}: PanelProps) {
  const { node, edges, memories, timeline } = detail
  const color = TYPE_COLORS[node.type] ?? '#6d6aff'
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setConfirmDelete(false)
  }, [node.id])

  function getNodeLabel(id: string): string {
    return rawNodes.find((n) => n.id === id)?.label ?? id.slice(0, 8)
  }

  async function handleDeleteNode() {
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    setBusy(true)
    await onDeleteNode(node.id)
    setBusy(false)
  }

  return (
    <div
      style={{
        width: 300,
        flexShrink: 0,
        background: 'rgba(10,12,22,0.92)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        borderLeft: '1px solid rgba(255,255,255,0.09)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        fontFamily: '-apple-system, BlinkMacSystemFont, SF Pro Text, system-ui, sans-serif'
      }}
    >
      {/* Header */}
      <div
        style={{ padding: '14px 16px 10px', display: 'flex', alignItems: 'flex-start', gap: 8 }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
            <span
              style={{
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                color,
                background: `${color}22`,
                borderRadius: 4,
                padding: '2px 6px'
              }}
            >
              {node.type}
            </span>
          </div>
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: 'rgba(235,240,255,0.92)',
              lineHeight: 1.3,
              wordBreak: 'break-word'
            }}
          >
            {node.label}
          </div>
        </div>
        <button
          onClick={onClose}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: 'rgba(140,160,200,0.5)',
            padding: 2,
            flexShrink: 0,
            marginTop: 1
          }}
        >
          <X size={14} />
        </button>
      </div>

      {/* Weight + dates */}
      <div style={{ padding: '0 16px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <div
            style={{
              flex: 1,
              height: 4,
              background: 'rgba(255,255,255,0.08)',
              borderRadius: 2,
              overflow: 'hidden'
            }}
          >
            <div
              style={{
                width: `${Math.min(node.weight * 100, 100)}%`,
                height: '100%',
                background: color,
                borderRadius: 2,
                transition: 'width 300ms'
              }}
            />
          </div>
          <span style={{ fontSize: 10, color: 'rgba(140,160,200,0.55)', flexShrink: 0 }}>
            {node.weight.toFixed(3)} weight
          </span>
        </div>
        <div style={{ fontSize: 10, color: 'rgba(140,160,200,0.4)' }}>
          {fmtDate(node.first_seen)} → {fmtDate(node.last_seen)}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {/* Edges */}
        {edges.length > 0 && (
          <div style={SECTION}>
            <div
              style={{
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: '0.05em',
                textTransform: 'uppercase',
                color: 'rgba(140,160,200,0.5)',
                marginBottom: 8
              }}
            >
              Connections ({edges.length})
            </div>
            {edges.map((e) => {
              const isOut = e.src_id === node.id
              const otherId = isOut ? e.dst_id : e.src_id
              return (
                <div
                  key={e.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    marginBottom: 5,
                    fontSize: 11
                  }}
                >
                  <span style={{ color: 'rgba(140,160,200,0.4)', fontSize: 9 }}>
                    {isOut ? '→' : '←'}
                  </span>
                  <RelLabel rel={e.rel} />
                  <span
                    style={{
                      color: 'rgba(180,195,230,0.7)',
                      flex: 1,
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    {getNodeLabel(otherId)}
                  </span>
                </div>
              )
            })}
          </div>
        )}

        {/* Memories */}
        <div style={SECTION}>
          <div
            style={{
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: '0.05em',
              textTransform: 'uppercase',
              color: 'rgba(140,160,200,0.5)',
              marginBottom: 8
            }}
          >
            Memories ({memories.length})
          </div>
          {memories.length === 0 && (
            <div style={{ fontSize: 11, color: 'rgba(140,160,200,0.35)' }}>No memories yet.</div>
          )}
          {memories.map((m) => (
            <div
              key={m.id}
              style={{
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.07)',
                borderRadius: 8,
                padding: '8px 10px',
                marginBottom: 6
              }}
            >
              <div
                style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 5 }}
              >
                <span
                  style={{
                    fontSize: 8,
                    fontWeight: 600,
                    letterSpacing: '0.06em',
                    textTransform: 'uppercase',
                    color: 'rgba(109,106,255,0.85)',
                    background: 'rgba(109,106,255,0.14)',
                    borderRadius: 3,
                    padding: '1px 4px'
                  }}
                >
                  {m.type}
                </span>
                <div
                  style={{
                    flex: 1,
                    height: 3,
                    background: 'rgba(255,255,255,0.07)',
                    borderRadius: 2,
                    overflow: 'hidden',
                    marginLeft: 2
                  }}
                >
                  <div
                    style={{
                      width: `${m.importance * 100}%`,
                      height: '100%',
                      background: 'rgba(109,106,255,0.6)',
                      borderRadius: 2
                    }}
                  />
                </div>
                <span style={{ fontSize: 9, color: 'rgba(140,160,200,0.4)' }}>
                  {m.importance.toFixed(1)}
                </span>
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: 'rgba(180,195,230,0.75)',
                  lineHeight: 1.4,
                  marginBottom: 6
                }}
              >
                {m.content}
              </div>
              <div style={{ display: 'flex', gap: 4 }}>
                <button
                  onClick={() => onArchiveMemory(m.id)}
                  title="Archive"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 3,
                    padding: '2px 7px',
                    background: 'none',
                    border: '1px solid rgba(255,255,255,0.09)',
                    borderRadius: 5,
                    cursor: 'pointer',
                    color: 'rgba(140,160,200,0.5)',
                    fontSize: 10
                  }}
                >
                  <Archive size={9} /> Archive
                </button>
                <button
                  onClick={() => onDeleteMemory(m.id)}
                  title="Delete memory"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 3,
                    padding: '2px 7px',
                    background: 'none',
                    border: '1px solid rgba(248,123,123,0.2)',
                    borderRadius: 5,
                    cursor: 'pointer',
                    color: 'rgba(248,123,123,0.6)',
                    fontSize: 10
                  }}
                >
                  <Trash2 size={9} /> Delete
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Timeline */}
        {timeline.length > 0 && (
          <div style={SECTION}>
            <div
              style={{
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: '0.05em',
                textTransform: 'uppercase',
                color: 'rgba(140,160,200,0.5)',
                marginBottom: 8
              }}
            >
              Timeline
            </div>
            {timeline
              .slice(-8)
              .reverse()
              .map((t) => (
                <div key={t.id} style={{ display: 'flex', gap: 8, marginBottom: 7 }}>
                  <span
                    style={{
                      fontSize: 8,
                      fontWeight: 600,
                      letterSpacing: '0.05em',
                      textTransform: 'uppercase',
                      color: 'rgba(140,160,200,0.45)',
                      background: 'rgba(255,255,255,0.05)',
                      borderRadius: 4,
                      padding: '2px 5px',
                      flexShrink: 0,
                      height: 'fit-content'
                    }}
                  >
                    {t.surface}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 11,
                        color: 'rgba(180,195,230,0.72)',
                        lineHeight: 1.35,
                        marginBottom: 2
                      }}
                    >
                      {t.summary}
                    </div>
                    <div style={{ fontSize: 9, color: 'rgba(140,160,200,0.4)' }}>
                      {fmtDate(t.occurred_at ?? t.observed_at)}
                    </div>
                  </div>
                </div>
              ))}
          </div>
        )}

        {/* Delete node */}
        <div style={{ ...SECTION, paddingTop: 14, paddingBottom: 16 }}>
          <button
            onClick={handleDeleteNode}
            disabled={busy}
            style={{
              width: '100%',
              padding: '7px 12px',
              background: confirmDelete ? 'rgba(248,123,123,0.15)' : 'none',
              border: `1px solid ${confirmDelete ? 'rgba(248,123,123,0.45)' : 'rgba(248,123,123,0.2)'}`,
              borderRadius: 8,
              cursor: 'pointer',
              color: confirmDelete ? 'rgba(248,123,123,0.95)' : 'rgba(248,123,123,0.55)',
              fontSize: 11,
              fontFamily: 'inherit',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 5,
              transition: 'all 150ms'
            }}
          >
            <Trash2 size={11} />
            {confirmDelete ? 'Confirm — permanently delete node?' : 'Delete node'}
            {confirmDelete && <ChevronRight size={11} />}
          </button>
          {confirmDelete && (
            <button
              onClick={() => setConfirmDelete(false)}
              style={{
                marginTop: 5,
                width: '100%',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                fontSize: 10,
                color: 'rgba(140,160,200,0.4)',
                fontFamily: 'inherit'
              }}
            >
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Main component ────────────────────────────────────────────────────────────

const BTN: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 5,
  padding: '5px 10px',
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 8,
  cursor: 'pointer',
  color: 'rgba(180,195,230,0.7)',
  fontSize: 11,
  fontFamily: 'inherit'
}

export default function MemoryGraph(): React.ReactElement {
  // Graph data
  const [graph, setGraph] = useState<{ nodes: GNode[]; links: GLink[] }>({
    nodes: [],
    links: []
  })
  const [rawNodes, setRawNodes] = useState<GraphNode[]>([])

  // UI state
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [detail, setDetail] = useState<NodeDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [loading, setLoading] = useState(true)
  const [stats, setStats] = useState({ nodes: 0, edges: 0 })

  // Canvas sizing via ResizeObserver
  const wrapRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      setSize({ w: entry.contentRect.width, h: entry.contentRect.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<ForceGraphMethods<any, any>>(undefined)
  const hasZoomed = useRef(false)

  const api = window.electron

  const load = useCallback(async () => {
    setLoading(true)
    hasZoomed.current = false
    try {
      const { nodes, edges } = await api.memory.getGraph()
      setGraph(buildGraph(nodes, edges))
      setRawNodes(nodes)
      setStats({ nodes: nodes.length, edges: edges.length })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Tune d3 forces right after graph renders, before significant sim ticks
  useEffect(() => {
    if (graph.nodes.length === 0) return
    const raf = requestAnimationFrame(() => {
      const fg = fgRef.current
      if (!fg) return
      const charge = fg.d3Force('charge') as { strength(v: number): void } | undefined
      charge?.strength(-130)
      const link = fg.d3Force('link') as { distance(v: number): void } | undefined
      link?.distance(40)
    })
    return () => cancelAnimationFrame(raf)
  }, [graph])

  // Initial zoom-to-fit after simulation warms up
  useEffect(() => {
    if (graph.nodes.length === 0 || hasZoomed.current) return
    hasZoomed.current = true
    const t = window.setTimeout(() => {
      fgRef.current?.zoomToFit(400, 60)
    }, 800)
    return () => window.clearTimeout(t)
  }, [graph])

  // Load node detail when selectedId changes
  useEffect(() => {
    if (!selectedId) {
      setDetail(null)
      return
    }
    setDetailLoading(true)
    api.memory.getNode(selectedId).then((d) => {
      setDetail(d as NodeDetail | null)
      setDetailLoading(false)
    })
  }, [selectedId])

  // Adjacency map for hover highlighting
  const adjacency = useMemo(() => {
    const m = new Map<string, Set<string>>()
    graph.links.forEach((l) => {
      const s = linkNodeId(l.source)
      const t = linkNodeId(l.target)
      if (!m.has(s)) m.set(s, new Set())
      if (!m.has(t)) m.set(t, new Set())
      m.get(s)!.add(t)
      m.get(t)!.add(s)
    })
    return m
  }, [graph])

  // Node canvas drawing — circles sized by degree, colored by type
  const nodeCanvasObject = useCallback(
    (node: object, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const n = node as GNode
      const r = getNodeRadius(n)
      const isSel = n.id === selectedId
      const isHov = n.id === hoverId
      const dim = hoverId != null && !isHov && !(adjacency.get(hoverId)?.has(n.id))
      const base = TYPE_COLORS[n.type] ?? '#6d6aff'

      ctx.globalAlpha = dim ? 0.14 : 1

      // Node fill
      ctx.beginPath()
      ctx.arc(n.x ?? 0, n.y ?? 0, r, 0, 2 * Math.PI)
      ctx.fillStyle = base
      ctx.fill()

      // Glow / ring for selected or hovered
      if (isSel || isHov) {
        ctx.lineWidth = 1.5 / globalScale
        ctx.strokeStyle = isSel ? 'rgba(255,255,255,0.9)' : `${base}cc`
        ctx.stroke()
      }

      // Zoom-gated label: show at high zoom, or always when selected/hovered
      if (globalScale > 1.4 || isSel || isHov) {
        const fontSize = 11 / globalScale
        ctx.font = `500 ${fontSize}px -apple-system, system-ui, sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        ctx.fillStyle = dim ? 'rgba(235,240,255,0.25)' : 'rgba(235,240,255,0.82)'
        ctx.fillText(n.label, n.x ?? 0, (n.y ?? 0) + r + 2 / globalScale)
      }

      ctx.globalAlpha = 1
    },
    [selectedId, hoverId, adjacency]
  )

  // Hit area matches drawn circle
  const nodePointerAreaPaint = useCallback(
    (node: object, color: string, ctx: CanvasRenderingContext2D) => {
      const n = node as GNode
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(n.x ?? 0, n.y ?? 0, getNodeRadius(n), 0, 2 * Math.PI)
      ctx.fill()
    },
    []
  )

  // Link color — dim non-connected edges on hover; red + animated for blocked
  const linkColor = useCallback(
    (link: object) => {
      const l = link as GLink
      const lit =
        hoverId == null ||
        linkNodeId(l.source) === hoverId ||
        linkNodeId(l.target) === hoverId
      if (BLOCKED(l.rel)) {
        return lit ? 'rgba(248,123,123,0.55)' : 'rgba(248,123,123,0.09)'
      }
      return lit ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.03)'
    },
    [hoverId]
  )

  const linkDirectionalParticles = useCallback((link: object) => {
    return BLOCKED((link as GLink).rel) ? 2 : 0
  }, [])

  // Delete / archive handlers
  async function handleDeleteNode(id: string) {
    await api.memory.deleteNode(id)
    let removedEdges = 0
    setGraph((prev) => {
      const links = prev.links.filter(
        (l) => linkNodeId(l.source) !== id && linkNodeId(l.target) !== id
      )
      removedEdges = prev.links.length - links.length
      return { nodes: prev.nodes.filter((n) => n.id !== id), links }
    })
    setRawNodes((prev) => prev.filter((n) => n.id !== id))
    setStats((prev) => ({ nodes: prev.nodes - 1, edges: prev.edges - removedEdges }))
    setSelectedId(null)
    setDetail(null)
  }

  async function handleDeleteMemory(id: string) {
    await api.memory.deleteMemory(id)
    setDetail((prev) =>
      prev ? { ...prev, memories: prev.memories.filter((m) => m.id !== id) } : prev
    )
  }

  async function handleArchiveMemory(id: string) {
    await api.memory.updateMemory(id, { status: 'superseded' })
    setDetail((prev) =>
      prev ? { ...prev, memories: prev.memories.filter((m) => m.id !== id) } : prev
    )
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: 'var(--bg-base)'
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '14px 24px 12px',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexShrink: 0,
          background: 'rgba(10,12,22,0.6)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)'
        }}
      >
        <div>
          <div
            style={{
              fontSize: 16,
              fontWeight: 700,
              letterSpacing: '-0.02em',
              color: 'rgba(235,240,255,0.92)'
            }}
          >
            Memory
          </div>
          <div style={{ fontSize: 11, color: 'rgba(140,160,200,0.45)', marginTop: 1 }}>
            {loading ? 'Loading…' : `${stats.nodes} nodes · ${stats.edges} edges`}
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <button
          style={BTN}
          onClick={() => fgRef.current?.zoomToFit(400, 60)}
          title="Zoom to fit"
        >
          <Maximize2 size={11} />
          Fit
        </button>
        <button onClick={load} disabled={loading} style={BTN}>
          <RefreshCw
            size={11}
            style={{ animation: loading ? 'spin 1s linear infinite' : undefined }}
          />
          Refresh
        </button>
      </div>

      {/* Canvas + panel */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Force graph canvas */}
        <div ref={wrapRef} style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
          {loading && graph.nodes.length === 0 && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'rgba(140,160,200,0.4)',
                fontSize: 12,
                zIndex: 10
              }}
            >
              Loading graph…
            </div>
          )}
          {!loading && graph.nodes.length === 0 && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 10,
                zIndex: 10
              }}
            >
              <div style={{ fontSize: 32 }}>🕸️</div>
              <div
                style={{ fontSize: 14, fontWeight: 600, color: 'rgba(235,240,255,0.6)' }}
              >
                No nodes yet
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: 'rgba(140,160,200,0.35)',
                  textAlign: 'center',
                  maxWidth: 280
                }}
              >
                As mypa processes signals, it builds a knowledge graph of your people,
                projects, tasks, and decisions here.
              </div>
            </div>
          )}

          {size.w > 0 && (
            <ForceGraph2D
              ref={fgRef}
              width={size.w}
              height={size.h}
              graphData={graph}
              backgroundColor="rgb(10,12,22)"
              nodeRelSize={1}
              nodeCanvasObject={nodeCanvasObject}
              nodePointerAreaPaint={nodePointerAreaPaint}
              linkColor={linkColor}
              linkWidth={1.2}
              linkDirectionalParticles={linkDirectionalParticles}
              linkDirectionalParticleWidth={2}
              linkDirectionalParticleColor={() => 'rgba(248,123,123,0.85)'}
              onNodeClick={(node) => setSelectedId((node as GNode).id)}
              onNodeHover={(node) => setHoverId(node ? (node as GNode).id : null)}
              onBackgroundClick={() => setSelectedId(null)}
              cooldownTime={Infinity}
              d3AlphaDecay={0.005}
              d3VelocityDecay={0.6}
            />
          )}

          {/* Type legend */}
          <div
            style={{
              position: 'absolute',
              bottom: 16,
              left: 16,
              display: 'flex',
              flexDirection: 'column',
              gap: 5,
              background: 'rgba(10,12,22,0.75)',
              backdropFilter: 'blur(8px)',
              WebkitBackdropFilter: 'blur(8px)',
              border: '1px solid rgba(255,255,255,0.07)',
              borderRadius: 8,
              padding: '8px 10px'
            }}
          >
            {TYPE_ORDER.map((t) => (
              <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: TYPE_COLORS[t],
                    flexShrink: 0
                  }}
                />
                <span
                  style={{
                    fontSize: 10,
                    color: 'rgba(180,195,230,0.5)',
                    textTransform: 'capitalize'
                  }}
                >
                  {t}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Detail panel */}
        {selectedId && (
          <div style={{ width: 300, flexShrink: 0 }}>
            {detailLoading || !detail ? (
              <div
                style={{
                  height: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'rgba(10,12,22,0.92)',
                  borderLeft: '1px solid rgba(255,255,255,0.09)',
                  color: 'rgba(140,160,200,0.4)',
                  fontSize: 12
                }}
              >
                Loading…
              </div>
            ) : (
              <NodeDetailPanel
                detail={detail}
                rawNodes={rawNodes}
                onClose={() => setSelectedId(null)}
                onDeleteNode={handleDeleteNode}
                onDeleteMemory={handleDeleteMemory}
                onArchiveMemory={handleArchiveMemory}
              />
            )}
          </div>
        )}
      </div>
    </div>
  )
}
