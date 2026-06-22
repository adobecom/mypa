import React, { useState, useEffect, useRef, KeyboardEvent } from 'react'
import { Sparkles, ArrowUp, Square, Check, X } from 'lucide-react'
import type { ChatMessage, ProposedChatAction, PendingToolApproval } from '../../../../../../shared/types'
import MarkdownText from '@renderer/components/MarkdownText'
import { useAutoGrowTextarea } from '@renderer/hooks/useAutoGrowTextarea'

interface Props {
  messages: ChatMessage[]
  streaming?: boolean
  streamingContent?: string
  onSend: (msg: string) => void
  sendDisabled?: boolean
  error?: string | null
  onStop?: () => void
  /** Called when the user approves a pending write action. */
  onApproveAction?: (message: ChatMessage, editedPayload?: Record<string, unknown>) => Promise<void>
  /** Called when the user dismisses a pending write action. */
  onDismissAction?: (message: ChatMessage) => Promise<void>
  /** In-flight canUseTool gate: shown while the stream is paused awaiting user decision. */
  pendingToolApproval?: PendingToolApproval | null
  onApproveToolUse?: (editedInput?: Record<string, unknown>) => Promise<void>
  onDenyToolUse?: () => Promise<void>
}

export default function ChatThread({
  messages,
  streaming,
  streamingContent,
  onSend,
  sendDisabled,
  error,
  onStop,
  onApproveAction,
  onDismissAction,
  pendingToolApproval,
  onApproveToolUse,
  onDenyToolUse
}: Props): React.ReactElement {
  const [input, setInput] = useState('')
  const threadRef = useRef<HTMLDivElement>(null)
  const inputRef = useAutoGrowTextarea(input)

  // Scroll the inner chat container to bottom; never touches the window scroll.
  useEffect(() => {
    const el = threadRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [messages, streamingContent])

  // Focus the input when this component mounts (panel/pod just opened).
  useEffect(() => {
    const el = inputRef.current
    if (el && !el.disabled) el.focus({ preventScroll: true })
  }, [])

  const handleSend = () => {
    if (!input.trim() || sendDisabled || streaming) return
    onSend(input.trim())
    setInput('')
  }

  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div>
      <div className="chat-thread" ref={threadRef}>
        {messages.filter((msg) => msg.content.trim() !== '' || msg.action).map((msg) => (
          <ChatBubble
            key={msg.id}
            message={msg}
            onApprove={onApproveAction ? (ep) => onApproveAction(msg, ep) : undefined}
            onDismiss={onDismissAction ? () => onDismissAction(msg) : undefined}
          />
        ))}
        {streaming && (() => {
          const segments = (streamingContent ?? '')
            .split('\x00SPLIT\x00')
            .filter((s) => s.trim())
          return (
            <>
              {segments.map((seg, i) => (
                <div key={i} className="chat-message chat-message--assistant">
                  <div className="chat-message__avatar"><Sparkles size={10} /></div>
                  <div className="chat-message__bubble">
                    <MarkdownText>{seg}</MarkdownText>
                  </div>
                </div>
              ))}
              <div className="chat-message chat-message--assistant">
                <div className="chat-message__avatar"><Sparkles size={10} /></div>
                <div className="chat-message__bubble">
                  <div className="chat-message__typing">
                    <span className="typing-dot" />
                    <span className="typing-dot" />
                    <span className="typing-dot" />
                    {segments.length === 0 && (
                      <span className="chat-message__thinking-label">Thinking…</span>
                    )}
                  </div>
                </div>
              </div>
            </>
          )
        })()}
        {pendingToolApproval && (
          <InlineToolApproval
            approval={pendingToolApproval}
            onApprove={onApproveToolUse}
            onDeny={onDenyToolUse}
          />
        )}
        {error && !streaming && (
          <div className="chat-message chat-message--assistant chat-message--error">
            <div className="chat-message__avatar"><Sparkles size={10} /></div>
            <div className="chat-message__bubble">{error}</div>
          </div>
        )}
      </div>

      <div className="chat-input-row">
        <textarea
          ref={inputRef}
          className="chat-input"
          rows={1}
          placeholder="Reply to Claude…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKey}
          disabled={sendDisabled || streaming}
        />
        {streaming && onStop ? (
          <button className="chat-stop-btn" onClick={onStop} title="Stop">
            <Square size={13} />
          </button>
        ) : (
          <button
            className="chat-send-btn"
            onClick={handleSend}
            disabled={!input.trim() || sendDisabled || streaming}
          >
            <ArrowUp size={13} />
          </button>
        )}
      </div>
    </div>
  )
}

const ACTION_VERB_LABELS: Record<string, string> = {
  comment: 'Post comment',
  label: 'Add label',
  reply: 'Send reply',
  send: 'Send message'
}

function ActionChip({
  action,
  onApprove,
  onDismiss
}: {
  action: ProposedChatAction
  onApprove?: (editedPayload?: Record<string, unknown>) => Promise<void>
  onDismiss?: () => Promise<void>
}): React.ReactElement {
  const [busy, setBusy] = useState(false)
  // Draft text for the editable payload field (body / message / labels)
  const draftKey = ['body', 'message', 'text', 'comment'].find(
    (k) => typeof (action.payload ?? {})[k] === 'string'
  )
  const [draft, setDraft] = useState<string>(
    draftKey ? String((action.payload ?? {})[draftKey]) : ''
  )
  const draftRef = useAutoGrowTextarea(draft)

  const verbLabel = ACTION_VERB_LABELS[action.verb] ?? action.verb
  const surfaceLabel = action.surface.charAt(0).toUpperCase() + action.surface.slice(1)
  const chipLabel = `${surfaceLabel} · ${verbLabel}`

  const handleApprove = async () => {
    if (busy || !onApprove) return
    setBusy(true)
    try {
      const ep = draftKey && draft.trim() ? { [draftKey]: draft } : undefined
      await onApprove(ep)
    } finally {
      setBusy(false)
    }
  }

  const handleDismiss = async () => {
    if (busy || !onDismiss) return
    setBusy(true)
    try {
      await onDismiss()
    } finally {
      setBusy(false)
    }
  }

  if (action.status === 'pending') {
    return (
      <div className="chat-action-chip chat-action-chip--pending">
        <div className="chat-action-chip__label">{chipLabel}</div>
        {action.target && (
          <div className="chat-action-chip__target">{action.target}</div>
        )}
        {draftKey && (
          <textarea
            ref={draftRef}
            className="chat-action-chip__draft"
            rows={2}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={busy}
          />
        )}
        <div className="chat-action-chip__buttons">
          <button
            className="btn btn--ghost btn--sm"
            onClick={handleDismiss}
            disabled={busy}
          >
            <X size={11} /> Dismiss
          </button>
          <button
            className="btn btn--primary btn--sm"
            onClick={handleApprove}
            disabled={busy || (!!draftKey && !draft.trim())}
          >
            <Check size={11} /> Approve
          </button>
        </div>
      </div>
    )
  }

  if (action.status === 'executed') {
    return (
      <div className="chat-action-chip chat-action-chip--done">
        <Check size={11} /> {chipLabel} · Done
        {action.resultText && (
          <span className="chat-action-chip__result"> — {action.resultText.slice(0, 120)}</span>
        )}
      </div>
    )
  }

  if (action.status === 'failed') {
    return (
      <div className="chat-action-chip chat-action-chip--failed">
        <X size={11} /> {chipLabel} · Failed
        {action.resultText && (
          <span className="chat-action-chip__result"> — {action.resultText.slice(0, 120)}</span>
        )}
      </div>
    )
  }

  // dismissed
  return (
    <div className="chat-action-chip chat-action-chip--dismissed">
      <X size={11} /> {chipLabel} · Dismissed
    </div>
  )
}

function InlineToolApproval({
  approval,
  onApprove,
  onDeny
}: {
  approval: PendingToolApproval
  onApprove?: (editedInput?: Record<string, unknown>) => Promise<void>
  onDeny?: () => Promise<void>
}): React.ReactElement {
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState(approval.editableValue ?? '')
  const draftRef = useAutoGrowTextarea(draft)

  const handleApprove = async () => {
    if (busy || !onApprove) return
    setBusy(true)
    try {
      const edited = approval.editableField && draft.trim()
        ? { [approval.editableField]: draft }
        : undefined
      await onApprove(edited)
    } finally { setBusy(false) }
  }

  const handleDeny = async () => {
    if (busy || !onDeny) return
    setBusy(true)
    try { await onDeny() } finally { setBusy(false) }
  }

  return (
    <div className="chat-action-chip chat-action-chip--pending">
      <div className="chat-action-chip__label">{approval.displayLabel}</div>
      {approval.editableField && (
        <textarea
          ref={draftRef}
          className="chat-action-chip__draft"
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={busy}
        />
      )}
      <div className="chat-action-chip__buttons">
        <button className="btn btn--ghost btn--sm" onClick={handleDeny} disabled={busy}>
          <X size={11} /> Dismiss
        </button>
        <button
          className="btn btn--primary btn--sm"
          onClick={handleApprove}
          disabled={busy || (!!approval.editableField && !draft.trim())}
        >
          <Check size={11} /> Approve
        </button>
      </div>
    </div>
  )
}

function ChatBubble({
  message,
  onApprove,
  onDismiss
}: {
  message: ChatMessage
  onApprove?: (editedPayload?: Record<string, unknown>) => Promise<void>
  onDismiss?: () => Promise<void>
}): React.ReactElement {
  const isUser = message.role === 'user'
  return (
    <div className={`chat-message chat-message--${message.role}`}>
      <div className="chat-message__avatar">{isUser ? 'U' : <Sparkles size={10} />}</div>
      <div className="chat-message__bubble">
        {message.content.trim() && <MarkdownText>{message.content}</MarkdownText>}
        {message.action && (
          <ActionChip
            action={message.action}
            onApprove={onApprove}
            onDismiss={onDismiss}
          />
        )}
      </div>
    </div>
  )
}
