import { useCallback, useEffect, useRef, useState } from 'react'
import type { Intent } from '@shared/types'

interface UseLiveIntents {
  intents: Intent[]
  setIntents: React.Dispatch<React.SetStateAction<Intent[]>>
  loading: boolean
  refetch: () => void
}

/**
 * Live-updating intent list shared by the widget and main window.
 *
 * `scope: 'pending'` (default) fetches only outstanding intents via
 * `ambient.getIntents()` — used by the widget's Queue tab.
 * `scope: 'all'` fetches the full history via `ambient.getAllIntents(limit)`
 * — used by the main window's Insights page (Queue/Observations/History tabs
 * all derive from the same full list, filtered client-side by type/status).
 *
 * Keeps the list current by:
 *  - merging on `ambient:intent-created` (upsert-prepend) and
 *    `ambient:intent-updated` (patch by id)
 *  - refetching on window focus as a safety net for any missed push event
 *
 * Every refetch merges the freshly-fetched list with any local entry that
 * wasn't already present as of the *previous* fetch, so a live-added intent
 * is never clobbered by a fetch that raced ahead of DB consistency. An entry
 * that was already confirmed present in an earlier fetch and has since
 * disappeared (aged out of the query window, or moved out of scope — e.g. a
 * 'pending' intent that got approved) is not preserved indefinitely; only
 * genuinely-new-since-last-check entries get the race protection.
 */
export function useLiveIntents(scope: 'pending' | 'all' = 'pending', limit = 200): UseLiveIntents {
  const [intents, setIntents] = useState<Intent[]>([])
  const [loading, setLoading] = useState(true)
  const api = window.electron
  const lastFetchIds = useRef<Set<string>>(new Set())

  const refetch = useCallback(() => {
    const fetch = scope === 'all' ? api.ambient.getAllIntents(limit) : api.ambient.getIntents()
    fetch
      .then((fetched) => {
        const fetchedList = fetched as Intent[]
        const byId = new Map(fetchedList.map((i) => [i.id, i]))
        setIntents((prev) => {
          for (const p of prev) {
            if (!byId.has(p.id) && !lastFetchIds.current.has(p.id)) {
              byId.set(p.id, p)
            }
          }
          return Array.from(byId.values())
        })
        lastFetchIds.current = new Set(fetchedList.map((i) => i.id))
        setLoading(false)
      })
      .catch((e) => {
        console.error('[useLiveIntents] refetch failed:', e)
        setLoading(false)
      })
  }, [scope, limit])

  useEffect(() => {
    refetch()
  }, [refetch])

  useEffect(() => {
    const onFocus = (): void => refetch()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refetch])

  useEffect(() => {
    const offCreated = api.on('ambient:intent-created', (intent) => {
      const i = intent as Intent
      setIntents((prev) => [i, ...prev.filter((x) => x.id !== i.id)])
    })
    const offUpdated = api.on('ambient:intent-updated', (updated) => {
      const u = updated as Partial<Intent> & { id: string }
      setIntents((prev) => prev.map((i) => (i.id === u.id ? { ...i, ...u } : i)))
    })
    return () => {
      offCreated()
      offUpdated()
    }
  }, [])

  return { intents, setIntents, loading, refetch }
}
