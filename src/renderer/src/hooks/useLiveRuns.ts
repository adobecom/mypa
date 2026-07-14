import { useCallback, useEffect, useState } from 'react'
import type { RoutineRun } from '@shared/types'

interface UseLiveRuns {
  runs: RoutineRun[]
  setRuns: React.Dispatch<React.SetStateAction<RoutineRun[]>>
  loading: boolean
  refetch: () => void
}

/**
 * Live-updating routine run list shared by the widget and main window.
 *
 * Fetches `limit` most-recent runs on mount, then keeps them current by:
 *  - upserting on `routine:run-started` / `routine:run-completed` (by `id`,
 *    prepending if the run isn't already in the list — a run outside the
 *    initial fetch window, or whose start event was missed, is still picked
 *    up on completion instead of silently dropped)
 *  - refetching on window focus, as a safety net for any push event missed
 *    while the window was unfocused or the renderer was busy
 *
 * The list is trimmed back to `limit` entries after a prepend so it doesn't
 * grow unbounded over a long-running session.
 */
export function useLiveRuns(limit: number): UseLiveRuns {
  const [runs, setRuns] = useState<RoutineRun[]>([])
  const [loading, setLoading] = useState(true)
  const api = window.electron

  const refetch = useCallback(() => {
    api.routines
      .getAllRuns(limit)
      .then((r) => {
        setRuns(r as RoutineRun[])
        setLoading(false)
      })
      .catch((e) => {
        console.error('[useLiveRuns] refetch failed:', e)
        setLoading(false)
      })
  }, [limit])

  useEffect(() => {
    refetch()
  }, [refetch])

  // Self-healing safety net: reconcile with the DB whenever the window regains
  // focus, in case a push event was missed while it was in the background.
  useEffect(() => {
    const onFocus = (): void => refetch()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refetch])

  useEffect(() => {
    const upsert = (run: RoutineRun): void => {
      setRuns((prev) => {
        const idx = prev.findIndex((r) => r.id === run.id)
        if (idx === -1) return [run, ...prev].slice(0, limit)
        const next = prev.slice()
        next[idx] = run
        return next
      })
    }
    const offStarted = api.on('routine:run-started', (run) => upsert(run as RoutineRun))
    const offCompleted = api.on('routine:run-completed', (run) => upsert(run as RoutineRun))
    return () => {
      offStarted()
      offCompleted()
    }
  }, [limit])

  return { runs, setRuns, loading, refetch }
}
