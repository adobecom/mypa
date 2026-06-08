import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle, XCircle, Info, Loader, X } from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────

export type ToastVariant = 'success' | 'error' | 'info' | 'loading'

export interface ToastInput {
  variant: ToastVariant
  title: string
  message?: string
  action?: { label: string; onClick: () => void }
  /** ms before auto-dismiss. 0 = sticky (use for loading). default 4000; errors default 8000 */
  duration?: number
}

interface Toast extends ToastInput {
  id: string
}

interface ToastApi {
  show(input: ToastInput): string
  update(id: string, patch: Partial<ToastInput>): void
  dismiss(id: string): void
  success(title: string, opts?: Partial<Omit<ToastInput, 'variant' | 'title'>>): string
  error(title: string, opts?: Partial<Omit<ToastInput, 'variant' | 'title'>>): string
  info(title: string, opts?: Partial<Omit<ToastInput, 'variant' | 'title'>>): string
  loading(title: string, opts?: Partial<Omit<ToastInput, 'variant' | 'title'>>): string
}

// ─── Context ──────────────────────────────────────────────────────────────────

const ToastContext = createContext<ToastApi | null>(null)

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>')
  return ctx
}

// ─── Provider ─────────────────────────────────────────────────────────────────

let _nextId = 0
const nextId = (): string => `t-${++_nextId}`

export function ToastProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [toasts, setToasts] = useState<Toast[]>([])
  // timer map: toastId → setTimeout handle (number in browser)
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const schedule = useCallback((id: string, duration: number) => {
    if (duration === 0) return
    const handle = setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
      timers.current.delete(id)
    }, duration)
    timers.current.set(id, handle)
  }, [])

  const clearTimer = useCallback((id: string) => {
    const h = timers.current.get(id)
    if (h != null) {
      clearTimeout(h)
      timers.current.delete(id)
    }
  }, [])

  const show = useCallback(
    (input: ToastInput): string => {
      const id = nextId()
      const duration = input.duration ?? (input.variant === 'error' ? 8000 : input.variant === 'loading' ? 0 : 4000)
      const toast: Toast = { ...input, id, duration }
      setToasts((prev) => [toast, ...prev])
      schedule(id, duration)
      return id
    },
    [schedule]
  )

  const update = useCallback(
    (id: string, patch: Partial<ToastInput>) => {
      clearTimer(id)
      setToasts((prev) =>
        prev.map((t) => {
          if (t.id !== id) return t
          const updated: Toast = { ...t, ...patch }
          // Recalculate default duration when variant changes
          if (patch.duration === undefined && patch.variant && patch.variant !== t.variant) {
            updated.duration = patch.variant === 'error' ? 8000 : patch.variant === 'loading' ? 0 : 4000
          }
          return updated
        })
      )
      // Schedule new dismiss for the updated toast
      const updatedDuration =
        patch.duration ?? (patch.variant === 'error' ? 8000 : patch.variant === 'loading' ? 0 : 4000)
      if (updatedDuration !== 0) schedule(id, updatedDuration)
    },
    [clearTimer, schedule]
  )

  const dismiss = useCallback(
    (id: string) => {
      clearTimer(id)
      setToasts((prev) => prev.filter((t) => t.id !== id))
    },
    [clearTimer]
  )

  // Memoized so useToast() returns a stable reference — consumers that capture
  // the value in a useEffect with [] deps won't hold a stale closure.
  const api = useMemo<ToastApi>(() => ({
    show,
    update,
    dismiss,
    success: (title, opts) => show({ variant: 'success', title, ...opts }),
    error:   (title, opts) => show({ variant: 'error',   title, ...opts }),
    info:    (title, opts) => show({ variant: 'info',    title, ...opts }),
    // duration: 0 is placed AFTER ...opts so callers cannot accidentally override
    // the sticky-zero contract by passing duration in opts.
    loading: (title, opts) => show({ variant: 'loading', title, ...opts, duration: 0 })
  }), [show, update, dismiss])

  return (
    <ToastContext.Provider value={api}>
      {children}
      {createPortal(<ToastContainer toasts={toasts} onDismiss={dismiss} />, document.body)}
    </ToastContext.Provider>
  )
}

// ─── Container + Item ─────────────────────────────────────────────────────────

const ICONS: Record<ToastVariant, React.ReactElement> = {
  success: <CheckCircle size={15} strokeWidth={2} />,
  error:   <XCircle    size={15} strokeWidth={2} />,
  info:    <Info       size={15} strokeWidth={2} />,
  loading: <Loader     size={15} strokeWidth={2} className="toast__icon--spin" />
}

function ToastContainer({
  toasts,
  onDismiss
}: {
  toasts: Toast[]
  onDismiss: (id: string) => void
}): React.ReactElement {
  return (
    <div className="toast-container">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  )
}

function ToastItem({
  toast: t,
  onDismiss
}: {
  toast: Toast
  onDismiss: (id: string) => void
}): React.ReactElement {
  return (
    <div className={`toast toast--${t.variant}`} role="alert" aria-live="polite">
      <span className={`toast__icon toast__icon--${t.variant}`}>{ICONS[t.variant]}</span>

      <div className="toast__body">
        <span className="toast__title">{t.title}</span>
        {t.message && <span className="toast__message">{t.message}</span>}
        {t.action && (
          <button
            className="toast__action"
            onClick={() => {
              t.action!.onClick()
              onDismiss(t.id)
            }}
          >
            {t.action.label}
          </button>
        )}
      </div>

      <button
        className="toast__close"
        aria-label="Dismiss"
        onClick={() => onDismiss(t.id)}
      >
        <X size={12} strokeWidth={2.5} />
      </button>
    </div>
  )
}
