import { useLayoutEffect, useRef } from 'react'

/**
 * Auto-resizes a textarea to fit its content, capped at `maxRows` lines.
 *
 * Usage:
 *   const ref = useAutoGrowTextarea(value)
 *   <textarea ref={ref} value={value} ... />
 *
 * The hook fires on every (re)mount via a callback ref, so textareas inside
 * conditionally-rendered blocks (collapsed/expanded cards) are correctly sized
 * even when they remount with an unchanged value.  It also re-sizes after every
 * render where `value` or `maxRows` changes, using `useLayoutEffect` so the
 * element is measured before paint — no one-frame squash flash.
 *
 * Below the cap: no scrollbar and the element shrinks as text is deleted.
 * At the cap: overflowY switches to 'auto'.
 *
 * The returned ref carries a `.current` property so consumers can read the
 * underlying element (e.g. to call `.focus()`).
 *
 * @param value   - the controlled value bound to the textarea (triggers resize)
 * @param maxRows - maximum rows before scrolling starts (default: 4)
 */

/** Callback ref that also exposes `.current` for imperative access. */
type AutoGrowRef = ((node: HTMLTextAreaElement | null) => void) & {
  current: HTMLTextAreaElement | null
}

function applyResize(el: HTMLTextAreaElement, maxRows: number): void {
  const cs = window.getComputedStyle(el)
  // line-height can be 'normal' (≈ 1.4× font-size) or a pixel value
  const lhRaw = cs.lineHeight
  const lhPx = lhRaw === 'normal' ? parseFloat(cs.fontSize) * 1.4 : parseFloat(lhRaw)
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
}

export function useAutoGrowTextarea(value: string, maxRows = 4): AutoGrowRef {
  // Keep latest maxRows accessible inside the stable callback without recreating it.
  const maxRowsRef = useRef(maxRows)
  maxRowsRef.current = maxRows

  // Build the callback ref once per hook instance so its identity stays stable.
  // It also carries `.current` so callers can read the DOM node (e.g. `.focus()`).
  const stableRef = useRef<AutoGrowRef | null>(null)
  if (stableRef.current === null) {
    const fn = ((node: HTMLTextAreaElement | null) => {
      fn.current = node
      // Size immediately on every attach — this is what fires on each (re)mount.
      if (node) applyResize(node, maxRowsRef.current)
    }) as AutoGrowRef
    fn.current = null
    stableRef.current = fn
  }

  // Re-apply sizing after value / maxRows changes (live typing, prop updates).
  // useLayoutEffect runs synchronously before paint — no one-frame squash flash.
  useLayoutEffect(() => {
    const el = stableRef.current!.current
    if (el) applyResize(el, maxRows)
  }, [value, maxRows])

  return stableRef.current!
}
