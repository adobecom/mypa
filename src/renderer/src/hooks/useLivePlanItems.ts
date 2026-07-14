import { useCallback, useEffect, useState } from 'react'
import type { PlanItem } from '@shared/types'

interface UseLivePlanItems {
  items: PlanItem[]
  setItems: React.Dispatch<React.SetStateAction<PlanItem[]>>
  loading: boolean
  refetch: () => void
}

/**
 * Live-updating plan item list shared by the widget and main window.
 *
 * Fetches all plan items on mount, then keeps them current by:
 *  - upserting on `plan:item-updated` (by `id`, prepending if not yet present)
 *  - refetching in full on `badge:updated` (a new item was likely created)
 *  - refetching on window focus as a safety net for any missed push event
 */
export function useLivePlanItems(): UseLivePlanItems {
  const [items, setItems] = useState<PlanItem[]>([])
  const [loading, setLoading] = useState(true)
  const api = window.electron

  const refetch = useCallback(() => {
    api.plan
      .getAll()
      .then((list) => {
        setItems(list as PlanItem[])
        setLoading(false)
      })
      .catch((e) => {
        console.error('[useLivePlanItems] refetch failed:', e)
        setLoading(false)
      })
  }, [])

  useEffect(() => {
    refetch()
  }, [refetch])

  useEffect(() => {
    const onFocus = (): void => refetch()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refetch])

  useEffect(() => {
    const offUpdated = api.on('plan:item-updated', (item) => {
      const p = item as PlanItem
      setItems((prev) => {
        const idx = prev.findIndex((i) => i.id === p.id)
        if (idx === -1) return [p, ...prev]
        const next = prev.slice()
        next[idx] = p
        return next
      })
    })
    const offBadge = api.on('badge:updated', () => refetch())
    return () => {
      offUpdated()
      offBadge()
    }
  }, [refetch])

  return { items, setItems, loading, refetch }
}
