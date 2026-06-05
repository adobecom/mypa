import React, { useState, useRef, useMemo, useEffect } from 'react'
import { ArrowLeft, Check, ExternalLink } from 'lucide-react'
import { MCP_CATALOG, CATALOG_CATEGORIES, type McpCatalogEntry } from '@shared/mcp-catalog'
import type { McpServerConfig, DeviceFlowStart } from '@shared/types'

interface Props {
  onAdd: (srv: McpServerConfig) => void
  onCancel: () => void
}

export default function ServerCatalogPicker({ onAdd, onCancel }: Props): React.ReactElement {
  const [selected, setSelected] = useState<McpCatalogEntry | null>(null)

  if (selected) {
    return (
      <ConfigurePanel
        entry={selected}
        onBack={() => setSelected(null)}
        onAdd={onAdd}
      />
    )
  }

  return <CatalogGrid onSelect={setSelected} onCancel={onCancel} />
}

// ─── Phase A: Catalog grid ────────────────────────────────────────────────────

function CatalogGrid({
  onSelect,
  onCancel
}: {
  onSelect: (entry: McpCatalogEntry) => void
  onCancel: () => void
}): React.ReactElement {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { inputRef.current?.focus() }, [])

  const isSearching = query.trim().length > 0
  const q = query.toLowerCase().trim()

  const filtered = useMemo(() => {
    if (!q) return MCP_CATALOG
    return MCP_CATALOG
      .filter((e) => e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q))
      .sort((a, b) => {
        const aName = a.name.toLowerCase().includes(q)
        const bName = b.name.toLowerCase().includes(q)
        return bName && !aName ? 1 : aName && !bName ? -1 : 0
      })
  }, [q])

  const renderRow = (entry: McpCatalogEntry) => (
    <button
      key={entry.id}
      className="btn btn--ghost"
      onClick={() => onSelect(entry)}
      style={{ justifyContent: 'flex-start', textAlign: 'left', padding: '6px 10px', gap: 10 }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500 }}>{entry.name}</div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.description}</div>
      </div>
      <AuthBadge authType={entry.authType} />
    </button>
  )

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>Choose a server to add</div>
        <button className="btn btn--ghost btn--sm" onClick={onCancel}>Cancel</button>
      </div>

      <input
        ref={inputRef}
        className="form-input"
        placeholder="Search servers…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        style={{ marginBottom: 10 }}
      />

      {filtered.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: '16px 0' }}>
          No servers match "{query}"
        </div>
      )}

      {isSearching ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {filtered.map(renderRow)}
        </div>
      ) : (
        CATALOG_CATEGORIES.map((category) => {
          const entries = MCP_CATALOG.filter((e) => e.category === category)
          if (entries.length === 0) return null
          return (
            <div key={category} style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
                {category}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {entries.map(renderRow)}
              </div>
            </div>
          )
        })
      )}
    </div>
  )
}

function AuthBadge({ authType }: { authType: McpCatalogEntry['authType'] }): React.ReactElement {
  const label = authType === 'oauth' ? 'OAuth' : authType === 'api_key' ? 'API key' : 'No auth'
  const color = authType === 'oauth' ? 'var(--accent)' : authType === 'api_key' ? 'var(--text-muted)' : 'var(--text-muted)'
  return (
    <span style={{ fontSize: 10, color, border: `1px solid ${color}`, borderRadius: 4, padding: '1px 5px', flexShrink: 0 }}>
      {label}
    </span>
  )
}

// ─── Phase B: Configure panel ─────────────────────────────────────────────────

function ConfigurePanel({
  entry,
  onBack,
  onAdd
}: {
  entry: McpCatalogEntry
  onBack: () => void
  onAdd: (srv: McpServerConfig) => void
}): React.ReactElement {
  const [envValues, setEnvValues] = useState<Record<string, string>>({})
  const [argValues, setArgValues] = useState<string[][]>(
    entry.argInputs?.map(() => ['']) ?? []
  )
  const [oauthToken, setOauthToken] = useState<string | null>(null)
  const [deviceFlow, setDeviceFlow] = useState<DeviceFlowStart | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [polling, setPolling] = useState(false)
  const [error, setError] = useState('')

  const api = window.electron

  const handleOAuthDevice = async () => {
    setError('')
    setConnecting(true)
    try {
      const flow = await api.oauth.startDevice()
      setDeviceFlow(flow)
      setPolling(true)
      // Start polling in background
      api.oauth.pollDevice(flow.deviceCode)
        .then((token) => {
          setOauthToken(token)
          setDeviceFlow(null)
        })
        .catch((err: Error) => setError(err.message))
        .finally(() => setPolling(false))
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Connection failed')
    } finally {
      setConnecting(false)
    }
  }

  const handleOAuthPkce = async () => {
    if (!entry.oauthProvider || entry.oauthProvider === 'github') return
    setError('')
    setConnecting(true)
    try {
      const token = await api.oauth.startPkce(entry.oauthProvider)
      setOauthToken(token)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Connection failed')
    } finally {
      setConnecting(false)
    }
  }

  const isReady = (): boolean => {
    if (entry.authType === 'oauth' && !oauthToken) return false
    if (entry.authType === 'api_key') {
      if (entry.requiredEnv?.some((f) => !envValues[f.key]?.trim())) return false
    }
    if (entry.argInputs) {
      for (const vals of argValues) {
        if (!vals.some((v) => v.trim())) return false
      }
    }
    return true
  }

  const handleAdd = () => {
    const resolvedArgs = (entry.argInputs ?? []).flatMap(
      (_, i) => argValues[i]?.filter((v) => v.trim()) ?? []
    )
    const env: Record<string, string> = { ...envValues }
    if (oauthToken && entry.oauthTokenEnvKey) {
      env[entry.oauthTokenEnvKey] = oauthToken
    }
    onAdd({
      name: entry.id,
      command: entry.command,
      args: [...entry.baseArgs, ...resolvedArgs],
      env: Object.keys(env).length ? env : undefined
    })
  }

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <button className="btn btn--ghost btn--sm" onClick={onBack} style={{ padding: '4px 6px' }}>
          <ArrowLeft size={14} />
        </button>
        <div>
          <div style={{ fontWeight: 600, fontSize: 14 }}>{entry.name}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{entry.description}</div>
        </div>
      </div>

      {error && <div className="alert alert--error" style={{ marginBottom: 10 }}>{error}</div>}

      {/* OAuth auth section */}
      {entry.authType === 'oauth' && (
        <div style={{ marginBottom: 12 }}>
          {entry.oauthProvider === 'github' ? (
            <DeviceFlowSection
              deviceFlow={deviceFlow}
              oauthToken={oauthToken}
              connecting={connecting}
              polling={polling}
              onConnect={handleOAuthDevice}
            />
          ) : (
            <PkceSection
              providerName={entry.name}
              oauthToken={oauthToken}
              connecting={connecting}
              onConnect={handleOAuthPkce}
            />
          )}
        </div>
      )}

      {/* API key fields */}
      {entry.authType === 'api_key' && entry.requiredEnv?.map((field) => (
        <div key={field.key} className="form-group">
          <label className="form-label">{field.label}</label>
          <input
            className="form-input form-input--mono"
            type={field.secret ? 'password' : 'text'}
            placeholder={field.placeholder}
            value={envValues[field.key] ?? ''}
            onChange={(e) => setEnvValues({ ...envValues, [field.key]: e.target.value })}
          />
          {field.hint && <div className="form-hint">{field.hint}</div>}
        </div>
      ))}

      {/* Arg inputs (e.g. filesystem paths) */}
      {entry.argInputs?.map((argInput, inputIdx) => (
        <div key={inputIdx} className="form-group">
          <label className="form-label">{argInput.label}</label>
          {(argValues[inputIdx] ?? ['']).map((val, lineIdx) => (
            <div key={lineIdx} style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
              <input
                className="form-input form-input--mono"
                style={{ flex: 1 }}
                placeholder={argInput.placeholder}
                value={val}
                onChange={(e) => {
                  const updated = [...(argValues[inputIdx] ?? [''])]
                  updated[lineIdx] = e.target.value
                  const next = [...argValues]
                  next[inputIdx] = updated
                  setArgValues(next)
                }}
              />
              {argInput.multiple && lineIdx === (argValues[inputIdx]?.length ?? 1) - 1 && (
                <button
                  className="btn btn--ghost btn--sm"
                  onClick={() => {
                    const next = [...argValues]
                    next[inputIdx] = [...(argValues[inputIdx] ?? ['']), '']
                    setArgValues(next)
                  }}
                >
                  +
                </button>
              )}
              {argInput.multiple && (argValues[inputIdx]?.length ?? 0) > 1 && (
                <button
                  className="btn btn--ghost btn--sm"
                  onClick={() => {
                    const next = [...argValues]
                    next[inputIdx] = (argValues[inputIdx] ?? []).filter((_, i) => i !== lineIdx)
                    setArgValues(next)
                  }}
                >
                  ×
                </button>
              )}
            </div>
          ))}
          {argInput.hint && <div className="form-hint">{argInput.hint}</div>}
        </div>
      ))}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 6 }}>
        <button className="btn btn--ghost btn--sm" onClick={onBack}>Back</button>
        <button
          className="btn btn--primary btn--sm"
          onClick={handleAdd}
          disabled={!isReady()}
        >
          Add {entry.name}
        </button>
      </div>
    </div>
  )
}

// ─── GitHub Device Flow sub-component ────────────────────────────────────────

function DeviceFlowSection({
  deviceFlow,
  oauthToken,
  connecting,
  polling,
  onConnect
}: {
  deviceFlow: DeviceFlowStart | null
  oauthToken: string | null
  connecting: boolean
  polling: boolean
  onConnect: () => void
}): React.ReactElement {
  if (oauthToken) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--color-success, #22c55e)', fontSize: 13 }}>
        <Check size={14} />
        Connected to GitHub
      </div>
    )
  }

  if (deviceFlow) {
    return (
      <div style={{ background: 'var(--bg-elevated)', borderRadius: 'var(--radius-md)', padding: '10px 12px' }}>
        <div style={{ fontSize: 13, marginBottom: 8 }}>
          Enter this code at{' '}
          <a
            href={deviceFlow.verificationUri}
            onClick={(e) => { e.preventDefault(); window.open(deviceFlow.verificationUri) }}
            style={{ color: 'var(--accent)' }}
          >
            {deviceFlow.verificationUri} <ExternalLink size={11} style={{ display: 'inline', verticalAlign: 'middle' }} />
          </a>
        </div>
        <div style={{ fontFamily: 'monospace', fontSize: 22, fontWeight: 700, letterSpacing: '0.15em', marginBottom: 8 }}>
          {deviceFlow.userCode}
        </div>
        {polling && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="spinner" style={{ width: 12, height: 12 }} />
            Waiting for authorization…
          </div>
        )}
      </div>
    )
  }

  return (
    <button
      className="btn btn--primary btn--sm"
      onClick={onConnect}
      disabled={connecting}
      style={{ width: '100%', justifyContent: 'center' }}
    >
      {connecting ? <span className="spinner" /> : 'Connect with GitHub'}
    </button>
  )
}

// ─── PKCE OAuth sub-component ────────────────────────────────────────────────

function PkceSection({
  providerName,
  oauthToken,
  connecting,
  onConnect
}: {
  providerName: string
  oauthToken: string | null
  connecting: boolean
  onConnect: () => void
}): React.ReactElement {
  if (oauthToken) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--color-success, #22c55e)', fontSize: 13 }}>
        <Check size={14} />
        Connected to {providerName}
      </div>
    )
  }

  return (
    <button
      className="btn btn--primary btn--sm"
      onClick={onConnect}
      disabled={connecting}
      style={{ width: '100%', justifyContent: 'center' }}
    >
      {connecting ? (
        <>
          <span className="spinner" />
          Waiting for browser…
        </>
      ) : (
        `Connect with ${providerName}`
      )}
    </button>
  )
}
