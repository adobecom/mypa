import React, { useState, useEffect, useMemo, useCallback } from 'react'
import {
  ReactFlow,
  useNodesState,
  useEdgesState,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  type Node,
  type Edge,
  type NodeProps,
  type NodeTypes
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { X, Trash2, Archive, RefreshCw, ChevronRight } from 'lucide-react'
import type { GraphNode, GraphEdge, Memory, NodeSignalLink, NodeType, EdgeRel } from '@shared/types'

// ─── Palette ──────────────────────────────────────────────────────────────────

const TYPE_COLORS: Record<NodeType, string> = {
  person: '#6d6aff',
  project: '#4ade9e',
  task: '#f59e60',
  decision: '#f87b7b'
}

const TYPE_ORDER: NodeType[] = ['person', 'project', 'task', 'decision']
const COL_X = [60, 340, 620, 900]
const ROW_GAP = 120

// ─── Layout helpers ───────────────────────────────────────────────────────────

function layoutNodes(nodes: GraphNode[]): Node<GraphNode>[] {
  const counts: Partial<Record<NodeType, number>> = {}
  return nodes.map((n) => {
    const col = TYPE_ORDER.indexOf(n.type)
    const x = col >= 0 ? COL_X[col] : 1180
    const row = counts[n.type] ?? 0
    counts[n.type] = row + 1
    return {
      id: n.id,
      type: 'graphNode',
      position: { x, y: 60 + row * ROW_GAP },
      data: n
    }
  })
}

function toFlowEdges(edges: GraphEdge[]): Edge[] {
  return edges.map((e) => ({
    id: e.id,
    source: e.src_id,
    target: e.dst_id,
    label: e.rel.replace(/_/g, ' '),
    labelStyle: { fontSize: 9, fill: 'rgba(140,160,200,0.65)', fontFamily: '-apple-system, system-ui, sans-serif' },
    labelBgStyle: { fill: 'rgba(10,12,22,0.75)', fillOpacity: 1 },
    labelBgPadding: [3, 5] as [number, number],
    style: {
      stroke: ['blocked_by', 'waiting_for'].includes(e.rel) ? 'rgba(248,123,123,0.5)' : 'rgba(255,255,255,0.16)',
      strokeWidth: 1.5
    },
    animated: ['blocked_by', 'waiting_for'].includes(e.rel)
  }))
}

// ─── Custom node ──────────────────────────────────────────────────────────────

function GraphNodeWidget({ data, selected }: NodeProps & { data: GraphNode }) {
  const color = TYPE_COLORS[data.type] ?? '#6d6aff'
  return (
    <div
      style={{
        background: selected ? `${color}1a` : 'rgba(255,255,255,0.055)',
        border: `1.5px solid ${selected ? color : 'rgba(255,255,255,0.11)'}`,
        borderRadius: 10,
        padding: '8px 12px',
        minWidth: 130,
        maxWidth: 210,
        cursor: 'pointer',
        color: 'rgba(235,240,255,0.92)',
        fontFamily: '-apple-system, BlinkMacSystemFont, SF Pro Text, system-ui, sans-serif',
        boxShadow: selected ? `0 0 0 3px ${color}22` : 'none',
        transition: 'border-color 150ms, box-shadow 150ms'
      }}
    >
      <Handle
        type="target"
        position={Position.Left}
        style={{ background: color, width: 7, height: 7, border: 'none' }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 4 }}>
        <span style={{
          fontSize: 9, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
          color, background: `${color}22`, borderRadius: 4, padding: '1px 5px', flexShrink: 0
        }}>
          {data.type}
        </span>
        <span style={{ fontSize: 9, color: 'rgba(140,160,200,0.45)', marginLeft: 'auto', flexShrink: 0 }}>
          {data.weight.toFixed(2)}
        </span>
      </div>
      <div style={{ fontSize: 12, fontWeight: 500, lineHeight: 1.35, wordBreak: 'break-word' }}>
        {data.label}
      </div>
      <Handle
        type="source"
        position={Position.Right}
        style={{ background: color, width: 7, height: 7, border: 'none' }}
      />
    </div>
  )
}

const nodeTypes: NodeTypes = { graphNode: GraphNodeWidget as React.ComponentType<NodeProps> }

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
    <span style={{
      fontSize: 9, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase',
      color: COLORS[rel] ?? 'rgba(180,195,230,0.6)',
      background: `${COLORS[rel] ?? '#888'}18`,
      borderRadius: 4, padding: '1px 5px'
    }}>
      {rel.replace(/_/g, ' ')}
    </span>
  )
}

interface PanelProps {
  detail: NodeDetail
  allNodes: Node<GraphNode>[]
  onClose(): void
  onDeleteNode(id: string): Promise<void>
  onDeleteMemory(id: string): Promise<void>
  onArchiveMemory(id: string): Promise<void>
}

function NodeDetailPanel({ detail, allNodes, onClose, onDeleteNode, onDeleteMemory, onArchiveMemory }: PanelProps) {
  const { node, edges, memories, timeline } = detail
  const color = TYPE_COLORS[node.type] ?? '#6d6aff'
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)

  // Reset confirm state when node changes
  useEffect(() => { setConfirmDelete(false) }, [node.id])

  function getNodeLabel(id: string): string {
    return allNodes.find((n) => n.id === id)?.data.label ?? id.slice(0, 8)
  }

  async function handleDeleteNode() {
    if (!confirmDelete) { setConfirmDelete(true); return }
    setBusy(true)
    await onDeleteNode(node.id)
    setBusy(false)
  }

  const SECTION: React.CSSProperties = {
    borderTop: '1px solid rgba(255,255,255,0.06)',
    padding: '12px 16px'
  }

  return (
    <div style={{
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
    }}>
      {/* Header */}
      <div style={{ padding: '14px 16px 10px', display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
            <span style={{
              fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
              color, background: `${color}22`, borderRadius: 4, padding: '2px 6px'
            }}>
              {node.type}
            </span>
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'rgba(235,240,255,0.92)', lineHeight: 1.3, wordBreak: 'break-word' }}>
            {node.label}
          </div>
        </div>
        <button
          onClick={onClose}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(140,160,200,0.5)', padding: 2, flexShrink: 0, marginTop: 1 }}
        >
          <X size={14} />
        </button>
      </div>

      {/* Weight + dates */}
      <div style={{ padding: '0 16px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <div style={{ flex: 1, height: 4, background: 'rgba(255,255,255,0.08)', borderRadius: 2, overflow: 'hidden' }}>
            <div style={{ width: `${Math.min(node.weight * 100, 100)}%`, height: '100%', background: color, borderRadius: 2, transition: 'width 300ms' }} />
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
            <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'rgba(140,160,200,0.5)', marginBottom: 8 }}>
              Connections ({edges.length})
            </div>
            {edges.map((e) => {
              const isOut = e.src_id === node.id
              const otherId = isOut ? e.dst_id : e.src_id
              return (
                <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5, fontSize: 11 }}>
                  <span style={{ color: 'rgba(140,160,200,0.4)', fontSize: 9 }}>{isOut ? '→' : '←'}</span>
                  <RelLabel rel={e.rel} />
                  <span style={{ color: 'rgba(180,195,230,0.7)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {getNodeLabel(otherId)}
                  </span>
                </div>
              )
            })}
          </div>
        )}

        {/* Memories */}
        <div style={SECTION}>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'rgba(140,160,200,0.5)', marginBottom: 8 }}>
            Memories ({memories.length})
          </div>
          {memories.length === 0 && (
            <div style={{ fontSize: 11, color: 'rgba(140,160,200,0.35)' }}>No memories yet.</div>
          )}
          {memories.map((m) => (
            <div key={m.id} style={{
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.07)',
              borderRadius: 8,
              padding: '8px 10px',
              marginBottom: 6
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 5 }}>
                <span style={{
                  fontSize: 8, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
                  color: 'rgba(109,106,255,0.85)', background: 'rgba(109,106,255,0.14)', borderRadius: 3, padding: '1px 4px'
                }}>
                  {m.type}
                </span>
                <div style={{ flex: 1, height: 3, background: 'rgba(255,255,255,0.07)', borderRadius: 2, overflow: 'hidden', marginLeft: 2 }}>
                  <div style={{ width: `${m.importance * 100}%`, height: '100%', background: 'rgba(109,106,255,0.6)', borderRadius: 2 }} />
                </div>
                <span style={{ fontSize: 9, color: 'rgba(140,160,200,0.4)' }}>{m.importance.toFixed(1)}</span>
              </div>
              <div style={{ fontSize: 11, color: 'rgba(180,195,230,0.75)', lineHeight: 1.4, marginBottom: 6 }}>
                {m.content}
              </div>
              <div style={{ display: 'flex', gap: 4 }}>
                <button
                  onClick={() => onArchiveMemory(m.id)}
                  title="Archive"
                  style={{
                    display: 'flex', alignItems: 'center', gap: 3, padding: '2px 7px',
                    background: 'none', border: '1px solid rgba(255,255,255,0.09)',
                    borderRadius: 5, cursor: 'pointer', color: 'rgba(140,160,200,0.5)', fontSize: 10
                  }}
                >
                  <Archive size={9} /> Archive
                </button>
                <button
                  onClick={() => onDeleteMemory(m.id)}
                  title="Delete memory"
                  style={{
                    display: 'flex', alignItems: 'center', gap: 3, padding: '2px 7px',
                    background: 'none', border: '1px solid rgba(248,123,123,0.2)',
                    borderRadius: 5, cursor: 'pointer', color: 'rgba(248,123,123,0.6)', fontSize: 10
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
            <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'rgba(140,160,200,0.5)', marginBottom: 8 }}>
              Timeline
            </div>
            {timeline.slice(-8).reverse().map((t) => (
              <div key={t.id} style={{ display: 'flex', gap: 8, marginBottom: 7 }}>
                <span style={{
                  fontSize: 8, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase',
                  color: 'rgba(140,160,200,0.45)', background: 'rgba(255,255,255,0.05)',
                  borderRadius: 4, padding: '2px 5px', flexShrink: 0, height: 'fit-content'
                }}>
                  {t.surface}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 11, color: 'rgba(180,195,230,0.72)', lineHeight: 1.35, marginBottom: 2 }}>
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
              style={{ marginTop: 5, width: '100%', background: 'none', border: 'none', cursor: 'pointer', fontSize: 10, color: 'rgba(140,160,200,0.4)', fontFamily: 'inherit' }}
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

export default function MemoryGraph(): React.ReactElement {
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node<GraphNode>>([])
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<NodeDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [loading, setLoading] = useState(true)
  const [stats, setStats] = useState({ nodes: 0, edges: 0 })

  const api = window.electron

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { nodes, edges } = await api.memory.getGraph()
      setRfNodes(layoutNodes(nodes))
      setRfEdges(toFlowEdges(edges))
      setStats({ nodes: nodes.length, edges: edges.length })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (!selectedId) { setDetail(null); return }
    setDetailLoading(true)
    api.memory.getNode(selectedId).then((d) => {
      setDetail(d as NodeDetail | null)
      setDetailLoading(false)
    })
  }, [selectedId])

  const handleNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedId(node.id)
  }, [])

  const handlePaneClick = useCallback(() => {
    setSelectedId(null)
  }, [])

  async function handleDeleteNode(id: string) {
    await api.memory.deleteNode(id)
    setRfNodes((prev) => prev.filter((n) => n.id !== id))
    setRfEdges((prev) => prev.filter((e) => e.source !== id && e.target !== id))
    setStats((prev) => ({ ...prev, nodes: prev.nodes - 1 }))
    setSelectedId(null)
    setDetail(null)
  }

  async function handleDeleteMemory(id: string) {
    await api.memory.deleteMemory(id)
    setDetail((prev) => prev ? { ...prev, memories: prev.memories.filter((m) => m.id !== id) } : prev)
  }

  async function handleArchiveMemory(id: string) {
    await api.memory.updateMemory(id, { status: 'superseded' })
    setDetail((prev) => prev ? { ...prev, memories: prev.memories.filter((m) => m.id !== id) } : prev)
  }

  const miniMapNodeColor = useCallback((node: Node) => {
    return TYPE_COLORS[(node.data as GraphNode).type] ?? '#6d6aff'
  }, [])

  const proOptions = useMemo(() => ({ hideAttribution: true }), [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg-base)' }}>
      {/* Header */}
      <div style={{
        padding: '14px 24px 12px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexShrink: 0,
        background: 'rgba(10,12,22,0.6)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)'
      }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-0.02em', color: 'rgba(235,240,255,0.92)' }}>
            Memory
          </div>
          <div style={{ fontSize: 11, color: 'rgba(140,160,200,0.45)', marginTop: 1 }}>
            {loading ? 'Loading…' : `${stats.nodes} nodes · ${stats.edges} edges`}
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <button
          onClick={load}
          disabled={loading}
          style={{
            display: 'flex', alignItems: 'center', gap: 5,
            padding: '5px 10px', background: 'rgba(255,255,255,0.05)',
            border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8,
            cursor: 'pointer', color: 'rgba(180,195,230,0.7)', fontSize: 11, fontFamily: 'inherit'
          }}
        >
          <RefreshCw size={11} style={{ animation: loading ? 'spin 1s linear infinite' : undefined }} />
          Refresh
        </button>
      </div>

      {/* Canvas + panel */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* ReactFlow canvas */}
        <div style={{ flex: 1, position: 'relative' }}>
          {loading && rfNodes.length === 0 && (
            <div style={{
              position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'rgba(140,160,200,0.4)', fontSize: 12, zIndex: 10
            }}>
              Loading graph…
            </div>
          )}
          {!loading && rfNodes.length === 0 && (
            <div style={{
              position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center', gap: 10, zIndex: 10
            }}>
              <div style={{ fontSize: 32 }}>🕸️</div>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'rgba(235,240,255,0.6)' }}>No nodes yet</div>
              <div style={{ fontSize: 12, color: 'rgba(140,160,200,0.35)', textAlign: 'center', maxWidth: 280 }}>
                As mypa processes signals, it builds a knowledge graph of your people, projects, tasks, and decisions here.
              </div>
            </div>
          )}
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={handleNodeClick}
            onPaneClick={handlePaneClick}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            colorMode="dark"
            proOptions={proOptions}
          >
            <Background color="rgba(255,255,255,0.04)" gap={28} size={1} />
            <Controls
              style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.09)', borderRadius: 8 }}
            />
            <MiniMap
              nodeColor={miniMapNodeColor}
              maskColor="rgba(10,12,22,0.75)"
              style={{ background: 'rgba(10,12,22,0.6)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8 }}
            />
          </ReactFlow>
        </div>

        {/* Detail panel */}
        {selectedId && (
          <div style={{ width: 300, flexShrink: 0 }}>
            {detailLoading || !detail ? (
              <div style={{
                height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'rgba(10,12,22,0.92)', borderLeft: '1px solid rgba(255,255,255,0.09)',
                color: 'rgba(140,160,200,0.4)', fontSize: 12
              }}>
                Loading…
              </div>
            ) : (
              <NodeDetailPanel
                detail={detail}
                allNodes={rfNodes}
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
