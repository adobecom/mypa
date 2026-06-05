import React, { useState, useEffect } from 'react'
import { Check, Minus, MessageSquare, ChevronUp, CornerUpLeft } from 'lucide-react'
import ChatThread from './ChatThread'
import type { PlanItem, ChatMessage } from '../../../../../../shared/types'

interface Props {
  item: PlanItem
  onStatusChange: (id: string, status: PlanItem['status']) => void
  onDelete: (id: string) => void
  collapsed?: boolean
}

export default function PlanItemCard({
  item,
  onStatusChange,
  onDelete,
  collapsed
}: Props): React.ReactElement {
  const [expanded, setExpanded] = useState(false)
  const [thread, setThread] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState(false)
  const [streamContent, setStreamContent] = useState('')
  const [chatError, setChatError] = useState<string | null>(null)

  const api = window.electron
  const isDone = item.status === 'done'
  const isSkipped = item.status === 'skipped'

  useEffect(() => {
    if (!expanded) return
    api.plan.getThread(item.id).then(setThread)
  }, [expanded, item.id])

  // Listen for streaming messages
  useEffect(() => {
    if (!expanded) return
    const unsub = api.on('plan:item-message', (payload) => {
      const p = payload as { itemId: string; chunk: string; done: boolean; error?: string }
      if (p.itemId !== item.id) return
      if (p.done) {
        setStreaming(false)
        setStreamContent('')
        if (p.error) {
          setChatError(p.error)
        } else {
          api.plan.getThread(item.id).then(setThread)
        }
      } else {
        setStreaming(true)
        setStreamContent((prev) => prev + p.chunk)
      }
    })
    return unsub
  }, [expanded, item.id])

  const handleCheck = () => {
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
    setStreaming(true)
    setStreamContent('')
    setThread((prev) => [
      ...prev,
      { id: Date.now().toString(), role: 'user', content: msg, timestamp: new Date().toISOString() }
    ])
    await api.plan.sendMessage(item.id, msg)
  }

  const checkboxClass = `plan-item__checkbox${isDone ? ' checked' : isSkipped ? ' skipped' : ''}`

  return (
    <div className={`plan-item${expanded ? ' active' : ''}`}>
      <button className={checkboxClass} onClick={handleCheck}>
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
