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
    // Account for actual border widths (handles both content-box and border-box)
    const borderV =
      (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0)
    const isBorderBox = cs.boxSizing === 'border-box'

    // maxH is always the total CSS height we will set on the element
    const maxH = lhPx * maxRows + padTop + padBot + borderV

    el.style.height = 'auto'
    // scrollHeight = content + padding (no border).
    // Under border-box the CSS height must include borders, so add them back.
    const natural = el.scrollHeight + (isBorderBox ? borderV : 0)
    el.style.height = Math.min(natural, maxH) + 'px'
    el.style.overflowY = natural > maxH ? 'auto' : 'hidden'
  }, [value, maxRows])

  return ref
}
