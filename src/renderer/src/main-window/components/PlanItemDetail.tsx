import React, { useState, useEffect, useRef } from 'react'
import { ArrowLeft } from 'lucide-react'
import ChatThread from '../../widget/components/ChatThread'
import type { PlanItem, ChatMessage } from '../../../../../../shared/types'

interface Props {
  itemId: string | null
  onBack: () => void
}

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  in_progress: 'In progress',
  done: 'Done',
  skipped: 'Skipped'
}

export default function PlanItemDetail({ itemId, onBack }: Props): React.ReactElement {
  const [item, setItem] = useState<PlanItem | null>(null)
  const [thread, setThread] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState(false)
  const [streamContent, setStreamContent] = useState('')
  const [chatError, setChatError] = useState<string | null>(null)
  const safetyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (safetyTimer.current) clearTimeout(safetyTimer.current) }, [])

  const api = window.electron

  useEffect(() => {
    if (!itemId) return
    api.plan.getItem(itemId).then((i) => setItem(i as PlanItem | null))
    api.plan.getThread(itemId).then(setThread)
  }, [itemId])

  useEffect(() => {
    if (!itemId) return
    const unsub = api.on('plan:item-updated', (payload) => {
      const p = payload as { id: string; status: string }
      if (p.id !== itemId) return
      setItem((prev) => prev ? { ...prev, status: p.status as PlanItem['status'] } : prev)
    })
    return unsub
  }, [itemId])

  useEffect(() => {
    if (!itemId) return
    const unsub = api.on('plan:user-message', (payload) => {
      const p = payload as { itemId: string; message: ChatMessage }
      if (p.itemId !== itemId) return
      setThread((prev) => [...prev, p.message])
      setStreaming(true)
      if (safetyTimer.current) clearTimeout(safetyTimer.current)
      safetyTimer.current = setTimeout(() => {
        setStreaming(false)
        setChatError('The assistant stopped responding. Please try again.')
      }, 150_000)
    })
    return unsub
  }, [itemId])

  useEffect(() => {
    if (!itemId) return
    const unsub = api.on('plan:item-message', (payload) => {
      const p = payload as { itemId: string; chunk: string; done: boolean; error?: string }
      if (p.itemId !== itemId) return
      if (p.done) {
        if (safetyTimer.current) { clearTimeout(safetyTimer.current); safetyTimer.current = null }
        setStreaming(false)
        setStreamContent('')
        if (p.error) {
          setChatError(p.error)
        } else {
          api.plan.getThread(itemId).then(setThread)
        }
      } else {
        if (safetyTimer.current) clearTimeout(safetyTimer.current)
        safetyTimer.current = setTimeout(() => {
          setStreaming(false)
          setChatError('The assistant stopped responding. Please try again.')
        }, 150_000)
        setStreaming(true)
        setStreamContent((prev) => prev + p.chunk)
      }
    })
    return unsub
  }, [itemId])

  const handleSend = async (msg: string) => {
    if (!itemId) return
    setChatError(null)
    setStreamContent('')
    await api.plan.sendMessage(itemId, msg)
  }

  const handleStop = async () => {
    if (!itemId) return
    await api.plan.cancelStream(itemId)
    setStreaming(false)
    setStreamContent('')
  }

  if (!itemId) {
    return (
      <div style={{ padding: 24, color: 'var(--text-muted)', fontSize: 13 }}>
        No item selected.
      </div>
    )
  }

  return (
    <div className="main-content">
      <div className="page-header" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button
          className="btn btn--ghost"
          style={{ padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}
          onClick={onBack}
        >
          <ArrowLeft size={13} />
          Back to plan
        </button>
      </div>

      {item ? (
        <>
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
              {item.title}
            </div>
            {item.detail && (
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 8 }}>
                {item.detail}
              </div>
            )}
            <span className="tag tag--neutral" style={{ fontSize: 11 }}>
              {STATUS_LABELS[item.status] ?? item.status}
            </span>
          </div>

          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-muted)', fontSize: 12, color: 'var(--text-muted)' }}>
              Conversation
            </div>
            <div style={{ padding: '12px 16px' }}>
              <ChatThread
                messages={thread}
                streaming={streaming}
                streamingContent={streamContent}
                onSend={handleSend}
                onStop={handleStop}
                sendDisabled={streaming || item.status === 'done' || item.status === 'skipped'}
                error={chatError}
              />
            </div>
          </div>
        </>
      ) : (
        <div style={{ padding: 24, color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>
      )}
    </div>
  )
}
