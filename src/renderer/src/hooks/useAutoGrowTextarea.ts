import { useEffect, useRef } from 'react'

/**
 * Auto-resizes a textarea to fit its content, capped at `maxRows` lines.
 *
 * Usage:
 *   const ref = useAutoGrowTextarea(value)
 *   <textarea ref={ref} value={value} ... />
 *
 * The hook drives `height` and `overflowY` via inline style after every
 * render where `value` changes.  Below the cap: no scrollbar and the element
 * shrinks as text is deleted.  At the cap: overflowY switches to 'auto'.
 *
 * @param value  - the controlled value bound to the textarea (triggers resize)
 * @param maxRows - maximum rows before scrolling starts (default: 4)
 */
export function useAutoGrowTextarea(value: string, maxRows = 4): React.RefObject<HTMLTextAreaElement> {
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const cs = window.getComputedStyle(el)
    // line-height can be 'normal' (≈ 1.4× font-size) or a pixel value
    const lhRaw = cs.lineHeight
    const lhPx =
      lhRaw === 'normal'
        ? parseFloat(cs.fontSize) * 1.4
        : parseFloat(lhRaw)
    const padTop = parseFloat(cs.paddingTop) || 0
    const padBot = parseFloat(cs.paddingBottom) || 0
    // Add 2px for borders so the last line of text is fully visible
    const maxH = lhPx * maxRows + padTop + padBot + 2

    el.style.height = 'auto'
    const natural = el.scrollHeight
    el.style.height = Math.min(natural, maxH) + 'px'
    el.style.overflowY = natural > maxH ? 'auto' : 'hidden'
  }, [value, maxRows])

  return ref
}
