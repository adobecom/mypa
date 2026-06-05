import React, { useState, useEffect, useRef, KeyboardEvent } from 'react'
import { Sparkles, ArrowUp, Square } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatMessage } from '../../../../../../shared/types'

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
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamingContent])

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
      <div className="chat-thread">
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
                  <div className="chat-message__bubble md-text">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{seg}</ReactMarkdown>
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
        <div ref={bottomRef} />
      </div>

      <div className="chat-input-row">
        <textarea
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
      <div className="chat-message__bubble md-text">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
      </div>
    </div>
  )
}
