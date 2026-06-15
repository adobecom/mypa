import React, { useState, useEffect, useRef, KeyboardEvent } from 'react'
import { Sparkles, ArrowUp, Square } from 'lucide-react'
import type { ChatMessage } from '../../../../../../shared/types'
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
}

export default function ChatThread({
  messages,
  streaming,
  streamingContent,
  onSend,
  sendDisabled,
  error,
  onStop
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
        {messages.filter((msg) => msg.content.trim() !== '').map((msg) => (
          <ChatBubble key={msg.id} message={msg} />
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

function ChatBubble({ message }: { message: ChatMessage }): React.ReactElement {
  const isUser = message.role === 'user'
  return (
    <div className={`chat-message chat-message--${message.role}`}>
      <div className="chat-message__avatar">{isUser ? 'U' : <Sparkles size={10} />}</div>
      <div className="chat-message__bubble">
        <MarkdownText>{message.content}</MarkdownText>
      </div>
    </div>
  )
}
