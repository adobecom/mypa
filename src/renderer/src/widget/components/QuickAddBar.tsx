import React, { useState, useRef, KeyboardEvent } from 'react'
import { Sparkles, CornerDownLeft } from 'lucide-react'
import { useAutoGrowTextarea } from '@renderer/hooks/useAutoGrowTextarea'

type Tab = 'queue' | 'routines'

interface Props {
  tab: Tab
  onSubmit: (value: string) => void
  loading?: boolean
  disabled?: boolean
}

export default function QuickAddBar({ tab, onSubmit, loading, disabled }: Props): React.ReactElement {
  const [value, setValue] = useState('')
  const textareaRef = useAutoGrowTextarea(value)

  const placeholder =
    tab === 'queue'
      ? 'What do you want to do? (e.g. review Alex\'s PR)'
      : 'What do you want to do?'

  const handleSubmit = () => {
    if (!value.trim() || loading || disabled) return
    onSubmit(value.trim())
    setValue('')
  }

  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  return (
    <div className="quick-add-bar">
      <span className="quick-add-bar__icon"><Sparkles size={14} strokeWidth={2} /></span>
      <textarea
        ref={textareaRef}
        className="quick-add-bar__input"
        rows={1}
        placeholder={disabled ? 'Loading…' : placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKey}
        disabled={disabled || loading}
      />
      {loading ? (
        <div className="spinner" />
      ) : (
        <button
          className="quick-add-bar__submit"
          onClick={handleSubmit}
          disabled={!value.trim() || disabled}
          title="Add (Enter)"
        >
          <CornerDownLeft size={13} />
        </button>
      )}
    </div>
  )
}
