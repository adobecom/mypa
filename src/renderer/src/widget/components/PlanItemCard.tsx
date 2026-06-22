import React, { useState, useEffect, useRef } from 'react'
import { Check, Minus, MessageSquare, ChevronUp, CornerUpLeft, ExternalLink } from 'lucide-react'
import ChatThread from './ChatThread'
import type { PlanItem, ChatMessage, PendingToolApproval } from '../../../../../../shared/types'

interface Props {
  item: PlanItem
  onStatusChange: (id: string, status: PlanItem['status']) => void
  onDelete: (id: string) => void
  collapsed?: boolean
  readOnly?: boolean
}

export default function PlanItemCard({
  item,
  onStatusChange,
  onDelete,
  collapsed,
  readOnly
}: Props): React.ReactElement {
  const [expanded, setExpanded] = useState(false)
  const [thread, setThread] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState(false)
  const [streamContent, setStreamContent] = useState('')
  const [chatError, setChatError] = useState<string | null>(null)
  const [pendingToolApproval, setPendingToolApproval] = useState<PendingToolApproval | null>(null)
  const safetyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (safetyTimer.current) clearTimeout(safetyTimer.current) }, [])

  const api = window.electron
  const isDone = item.status === 'done'
  const isSkipped = item.status === 'skipped'

  useEffect(() => {
    if (!expanded) return
    api.plan.getThread(item.id).then(setThread)
  }, [expanded, item.id])

  useEffect(() => {
    const unsub = api.on('plan:user-message', (payload) => {
      const p = payload as { itemId: string; message: ChatMessage }
      if (p.itemId !== item.id) return
      setThread((prev) => [...prev, p.message])
      setStreaming(true)
      if (safetyTimer.current) clearTimeout(safetyTimer.current)
      safetyTimer.current = setTimeout(() => {
        setStreaming(false)
        setChatError('The assistant stopped responding. Please try again.')
      }, 150_000)
    })
    return unsub
  }, [item.id])

  useEffect(() => {
    const unsub = api.on('plan:item-message', (payload) => {
      const p = payload as { itemId: string; chunk: string; done: boolean; error?: string }
      if (p.itemId !== item.id) return
      if (p.done) {
        if (safetyTimer.current) { clearTimeout(safetyTimer.current); safetyTimer.current = null }
        setPendingToolApproval(null)
        setStreaming(false)
        setStreamContent('')
        if (p.error) {
          setChatError(p.error)
        } else {
          api.plan.getThread(item.id).then(setThread)
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
  }, [item.id])

  useEffect(() => {
    const unsub = api.on('chat:tool-approval-request', (payload) => {
      const p = payload as PendingToolApproval
      if (p.streamId !== item.id) return
      setPendingToolApproval(p)
    })
    return unsub
  }, [item.id])

  const handleCheck = () => {
    if (readOnly) return
    if (isDone) {
      onStatusChange(item.id, 'pending')
    } else {
      onStatusChange(item.id, 'done')
    }
  }

  const handleSkip = () => {
    if (isSkipped) {
      onStatusChange(item.id, 'pending')
    } else {
      onStatusChange(item.id, 'skipped')
    }
  }

  const handleStop = async () => {
    await api.plan.cancelStream(item.id)
    setStreaming(false)
    setStreamContent('')
  }

  const handleSend = async (msg: string) => {
    setChatError(null)
    setStreamContent('')
    await api.plan.sendMessage(item.id, msg)
  }

  const checkboxClass = `plan-item__checkbox${isDone ? ' checked' : isSkipped ? ' skipped' : ''}${readOnly ? ' readonly' : ''}`

  return (
    <div className={`plan-item${expanded ? ' active' : ''}`}>
      <button className={checkboxClass} onClick={handleCheck} disabled={readOnly}>
        {isDone && <Check size={10} color="white" />}
        {isSkipped && <Minus size={10} color="var(--text-muted)" />}
      </button>

      <div className="plan-item__content" onClick={() => !collapsed && setExpanded((e) => !e)}>
        <div className={`plan-item__title${isDone || isSkipped ? ' done' : ''}`}>
          {item.title}
        </div>
        {item.detail && !collapsed && (
          <div className="plan-item__detail">{item.detail}</div>
        )}

        {expanded && (
          <div style={{ marginTop: 10 }} onClick={(e) => e.stopPropagation()}>
            <ChatThread
              messages={thread}
              streaming={streaming}
              streamingContent={streamContent}
              onSend={handleSend}
              onStop={handleStop}
              sendDisabled={streaming}
              error={chatError}
              pendingToolApproval={pendingToolApproval}
              onApproveToolUse={async (editedInput) => {
                if (!pendingToolApproval) return
                await api.chat.resolveToolApproval(pendingToolApproval.approvalId, true, editedInput)
                setPendingToolApproval(null)
              }}
              onDenyToolUse={async () => {
                if (!pendingToolApproval) return
                await api.chat.resolveToolApproval(pendingToolApproval.approvalId, false)
                setPendingToolApproval(null)
              }}
              onApproveAction={async (msg, editedPayload) => {
                try {
                  const updated = await api.plan.approveChatAction(item.id, msg.id, editedPayload)
                  setThread((prev) => prev.map((m) => m.id === msg.id ? { ...m, action: updated } : m))
                } catch (e) {
                  console.error('plan approveChatAction error:', e)
                }
              }}
              onDismissAction={async (msg) => {
                try {
                  const updated = await api.plan.dismissChatAction(item.id, msg.id)
                  setThread((prev) => prev.map((m) => m.id === msg.id ? { ...m, action: updated } : m))
                } catch (e) {
                  console.error('plan dismissChatAction error:', e)
                }
              }}
            />
          </div>
        )}
      </div>

      {!collapsed && (
        <div className="plan-item__actions">
          <button
            className="plan-item__thread-btn"
            onClick={(e) => { e.stopPropagation(); setExpanded((e) => !e) }}
            title="Chat with Claude about this"
          >
            {expanded ? <ChevronUp size={11} /> : <MessageSquare size={11} />}
          </button>
          {expanded && (
            <button
              className="plan-item__thread-btn"
              onClick={(e) => { e.stopPropagation(); api.plan.openInMainWindow(item.id) }}
              title="Open full chat in main window"
            >
              <ExternalLink size={11} />
            </button>
          )}
          <button
            className="plan-item__skip-btn"
            onClick={(e) => { e.stopPropagation(); handleSkip() }}
            title={isSkipped ? 'Un-skip' : 'Skip'}
          >
            {isSkipped ? <CornerUpLeft size={10} /> : <Minus size={10} />}
          </button>
        </div>
      )}
    </div>
  )
}
