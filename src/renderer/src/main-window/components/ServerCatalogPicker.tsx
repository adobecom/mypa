import React, { useState, useRef, useMemo, useEffect } from 'react'
import { ArrowLeft, Check, Copy, ExternalLink, Download, FolderOpen } from 'lucide-react'
import { MCP_CATALOG, CATALOG_CATEGORIES, type McpCatalogEntry } from '@shared/mcp-catalog'
import type { McpServerConfig, DeviceFlowStart, OAuthProvider, OAuthAppCredential, AppConfig, DetectedMcpServer } from '@shared/types'

interface Props {
  onAdd: (srv: McpServerConfig) => Promise<void> | void
  onCancel: () => void
  oauthCreds?: AppConfig['oauth_apps']
  onCredentialSave?: (provider: OAuthProvider, creds: OAuthAppCredential) => Promise<void>
  existingNames?: string[]
}

type Phase = 'catalog' | 'configure' | 'import'

export default function ServerCatalogPicker({ onAdd, onCancel, oauthCreds, onCredentialSave, existingNames = [] }: Props): React.ReactElement {
  const [phase, setPhase] = useState<Phase>('catalog')
  const [selected, setSelected] = useState<McpCatalogEntry | null>(null)

  if (phase === 'configure' && selected) {
    return (
      <ConfigurePanel
        entry={selected}
        onBack={() => { setPhase('catalog'); setSelected(null) }}
        onAdd={onAdd}
        oauthCreds={oauthCreds}
        onCredentialSave={onCredentialSave}
      />
    )
  }

  if (phase === 'import') {
    return (
      <ImportPanel
        existingNames={existingNames}
        onBack={() => setPhase('catalog')}
        onAdd={onAdd}
      />
    )
  }

  return (
    <CatalogGrid
      existingNames={existingNames}
      onSelect={(entry) => { setSelected(entry); setPhase('configure') }}
      onCancel={onCancel}
      onImport={() => setPhase('import')}
    />
  )
}

// ─── Phase A: Catalog grid ────────────────────────────────────────────────────

function CatalogGrid({
  onSelect,
  onCancel,
  onImport,
  existingNames
}: {
  onSelect: (entry: McpCatalogEntry) => void
  onCancel: () => void
  onImport: () => void
  existingNames: string[]
}): React.ReactElement {
  const [query, setQuery] = useState('')
  const [detected, setDetected] = useState<DetectedMcpServer[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { inputRef.current?.focus() }, [])

  useEffect(() => {
    window.electron.setup.detectClaudeMcp().then((servers) => {
      setDetected(servers.filter((s) => !existingNames.includes(s.name)))
    }).catch(() => {/* ignore */})
  }, [existingNames.join(',')])

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

      {/* Claude Code import banner */}
      {detected.length > 0 && (
        <button
          className="btn btn--ghost"
          onClick={onImport}
          style={{
            width: '100%',
            justifyContent: 'flex-start',
            gap: 8,
            marginBottom: 10,
            padding: '8px 12px',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--bg-elevated)'
          }}
        >
          <Download size={14} style={{ flexShrink: 0 }} />
          <div style={{ flex: 1, textAlign: 'left' }}>
            <div style={{ fontSize: 13, fontWeight: 500 }}>Import from Claude Code</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>
              {detected.length} server{detected.length !== 1 ? 's' : ''} found in your Claude Code config
            </div>
          </div>
        </button>
      )}

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
  onAdd,
  oauthCreds,
  onCredentialSave
}: {
  entry: McpCatalogEntry
  onBack: () => void
  onAdd: (srv: McpServerConfig) => Promise<void> | void
  oauthCreds?: AppConfig['oauth_apps']
  onCredentialSave?: (provider: OAuthProvider, creds: OAuthAppCredential) => Promise<void>
}): React.ReactElement {
  const [envValues, setEnvValues] = useState<Record<string, string>>({})
  const [argValues, setArgValues] = useState<string[][]>(
    entry.argInputs?.map(() => ['']) ?? []
  )
  const [oauthToken, setOauthToken] = useState<string | null>(null)
  const [patValue, setPatValue] = useState('')
  const [deviceFlow, setDeviceFlow] = useState<DeviceFlowStart | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [polling, setPolling] = useState(false)
  const [error, setError] = useState('')
  const [inlineClientId, setInlineClientId] = useState('')
  const [inlineClientSecret, setInlineClientSecret] = useState('')
  const [manifestCopyState, setManifestCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const manifestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleCopyManifest = async () => {
    if (!entry.appManifest) return
    if (manifestTimerRef.current) clearTimeout(manifestTimerRef.current)
    try {
      await navigator.clipboard.writeText(JSON.stringify(entry.appManifest, null, 2))
      setManifestCopyState('copied')
      manifestTimerRef.current = setTimeout(() => setManifestCopyState('idle'), 2000)
    } catch {
      setManifestCopyState('failed')
      manifestTimerRef.current = setTimeout(() => setManifestCopyState('idle'), 2000)
    }
  }

  const api = window.electron

  const provider = entry.oauthProvider as OAuthProvider | undefined
  const savedCreds = provider ? oauthCreds?.[provider] : undefined
  const credsMissing = entry.authType === 'oauth' && !!provider && !savedCreds?.clientId
  const needsSecret = provider === 'notion' || provider === 'linear'

  // Token from either OAuth flow or manually pasted PAT
  const effectiveToken = oauthToken ?? (patValue.trim() || null)

  const saveInlineCredsIfNeeded = async () => {
    if (!credsMissing || !provider || !inlineClientId.trim()) return
    const creds: OAuthAppCredential = {
      clientId: inlineClientId.trim(),
      ...(needsSecret && inlineClientSecret.trim() ? { clientSecret: inlineClientSecret.trim() } : {})
    }
    await onCredentialSave?.(provider, creds)
  }

  const handleOAuthDevice = async () => {
    setError('')
    setConnecting(true)
    try {
      await saveInlineCredsIfNeeded()
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
    if (!provider || provider === 'github') return
    setError('')
    setConnecting(true)
    try {
      await saveInlineCredsIfNeeded()
      const token = await api.oauth.startPkce(provider)
      setOauthToken(token)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Connection failed')
    } finally {
      setConnecting(false)
    }
  }

  const isReady = (): boolean => {
    if (entry.authType === 'oauth' && !effectiveToken) return false
    if (entry.authType === 'api_key') {
      if (entry.requiredEnv?.some((f) => !envValues[f.key]?.trim())) return false
    }
    if (entry.argInputs) {
      for (let i = 0; i < entry.argInputs.length; i++) {
        const argInput = entry.argInputs[i]
        const vals = argValues[i] ?? []
        if (!vals.some((v) => v.trim())) return false
        // For path inputs, require each non-empty value to be absolute or a valid tilde path (~ or ~/)
        if (argInput.isPath && vals.some((v) => {
          const t = v.trim()
          return t && !t.startsWith('/') && t !== '~' && !t.startsWith('~/')
        })) {
          return false
        }
      }
    }
    return true
  }

  const handleAdd = async () => {
    const resolvedArgs = (entry.argInputs ?? []).flatMap(
      (_, i) => argValues[i]?.filter((v) => v.trim()) ?? []
    )
    // Merge fixed catalog env first so user-supplied values can override if needed
    const env: Record<string, string> = { ...(entry.fixedEnv ?? {}), ...envValues }
    if (effectiveToken && entry.oauthTokenEnvKey) {
      env[entry.oauthTokenEnvKey] = effectiveToken
    }
    try {
      await onAdd({
        name: entry.id,
        command: entry.command,
        args: [...entry.baseArgs, ...resolvedArgs],
        env: Object.keys(env).length ? env : undefined
      })
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save server')
    }
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

      {/* OAuth app credentials (shown inline when not yet configured) */}
      {credsMissing && !oauthToken && !patValue.trim() && (
        <div style={{ marginBottom: 12, padding: '10px 12px', background: 'var(--bg-elevated)', borderRadius: 'var(--radius-md)' }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: 'var(--text-secondary)' }}>
            OAuth App Credentials
          </div>
          <div className="form-group">
            <label className="form-label">Client ID</label>
            <input
              className="form-input form-input--mono"
              type="text"
              placeholder={provider === 'github' ? 'Ov23li…' : 'your-client-id'}
              value={inlineClientId}
              onChange={(e) => setInlineClientId(e.target.value)}
            />
          </div>
          {needsSecret && (
            <div className="form-group">
              <label className="form-label">Client Secret</label>
              <input
                className="form-input form-input--mono"
                type="password"
                placeholder={provider === 'linear' ? 'lin_oauth_…' : 'secret_…'}
                value={inlineClientSecret}
                onChange={(e) => setInlineClientSecret(e.target.value)}
              />
            </div>
          )}
          <div className="form-hint">
            Register an OAuth app at {entry.name} with callback URL <code>mypa://oauth/callback</code>.
          </div>
        </div>
      )}

      {/* OAuth auth section */}
      {entry.authType === 'oauth' && (
        <div style={{ marginBottom: 12 }}>
          {/* OAuth buttons — hidden once the user has a token from either source */}
          {!oauthToken && !patValue.trim() && (
            entry.oauthProvider === 'github' ? (
              <DeviceFlowSection
                deviceFlow={deviceFlow}
                oauthToken={oauthToken}
                connecting={connecting}
                polling={polling}
                onConnect={handleOAuthDevice}
                disabled={credsMissing && !inlineClientId.trim()}
              />
            ) : (
              <PkceSection
                providerName={entry.name}
                oauthToken={oauthToken}
                connecting={connecting}
                onConnect={handleOAuthPkce}
                disabled={credsMissing && !inlineClientId.trim()}
              />
            )
          )}

          {/* PAT alternative — always shown until OAuth token is obtained */}
          {!oauthToken && entry.patLabel && (
            <>
              {!patValue.trim() && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '10px 0', color: 'var(--text-muted)', fontSize: 11 }}>
                  <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
                  or paste a token
                  <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
                </div>
              )}
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">{entry.patLabel}</label>
                <input
                  className="form-input form-input--mono"
                  type="password"
                  placeholder={entry.patPlaceholder}
                  value={patValue}
                  onChange={(e) => setPatValue(e.target.value)}
                />
                {entry.patHint && <div className="form-hint">{entry.patHint}</div>}
              </div>
            </>
          )}

          {/* Connected state — OAuth flow succeeded */}
          {oauthToken && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--color-success, #22c55e)', fontSize: 13 }}>
              <Check size={14} />
              Connected to {entry.name}
            </div>
          )}
        </div>
      )}

      {/* App manifest copy block */}
      {entry.appManifest && (
        <div style={{ marginBottom: 12, padding: '10px 12px', background: 'var(--bg-elevated)', borderRadius: 'var(--radius-md)' }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--text-secondary)' }}>
            App manifest
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
            Go to{' '}
            <a
              href="#"
              onClick={(e) => { e.preventDefault(); window.open('https://api.slack.com/apps', '_blank', 'noopener,noreferrer') }}
              style={{ color: 'var(--accent)' }}
            >
              api.slack.com/apps <ExternalLink size={10} style={{ display: 'inline', verticalAlign: 'middle' }} />
            </a>
            {' '}→ Create New App → From a manifest. The manifest pre-configures all required permissions.
          </div>
          <button
            className="btn btn--ghost btn--sm"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            onClick={handleCopyManifest}
          >
            {manifestCopyState === 'copied' ? <Check size={13} /> : <Copy size={13} />}
            {manifestCopyState === 'copied' ? 'Copied!' : manifestCopyState === 'failed' ? 'Copy failed' : 'Copy manifest'}
          </button>
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
      {entry.argInputs?.map((argInput, inputIdx) => {
        const vals = argValues[inputIdx] ?? ['']
        const hasRelativePath = argInput.isPath && vals.some((v) => {
          const t = v.trim()
          return t && !t.startsWith('/') && t !== '~' && !t.startsWith('~/')
        })

        const handleBrowse = async () => {
          const picked = await window.electron.system.pickDirectory(argInput.multiple ?? false)
          if (!picked.length) return
          // Merge picked paths with existing non-empty rows
          const existing = vals.filter((v) => v.trim())
          const merged = [...new Set([...existing, ...picked])]
          const next = [...argValues]
          next[inputIdx] = merged.length ? merged : ['']
          setArgValues(next)
        }

        return (
          <div key={inputIdx} className="form-group">
            <label className="form-label">{argInput.label}</label>
            {vals.map((val, lineIdx) => (
              <div key={lineIdx} style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
                <input
                  className="form-input form-input--mono"
                  style={{ flex: 1 }}
                  placeholder={argInput.placeholder}
                  value={val}
                  onChange={(e) => {
                    const updated = [...vals]
                    updated[lineIdx] = e.target.value
                    const next = [...argValues]
                    next[inputIdx] = updated
                    setArgValues(next)
                  }}
                />
                {argInput.multiple && lineIdx === vals.length - 1 && (
                  <button
                    className="btn btn--ghost btn--sm"
                    onClick={() => {
                      const next = [...argValues]
                      next[inputIdx] = [...vals, '']
                      setArgValues(next)
                    }}
                  >
                    +
                  </button>
                )}
                {argInput.multiple && vals.length > 1 && (
                  <button
                    className="btn btn--ghost btn--sm"
                    onClick={() => {
                      const next = [...argValues]
                      next[inputIdx] = vals.filter((_, i) => i !== lineIdx)
                      setArgValues(next)
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
            {argInput.isPath && (
              <button
                className="btn btn--ghost btn--sm"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginBottom: 4 }}
                onClick={handleBrowse}
              >
                <FolderOpen size={13} />
                Browse…
              </button>
            )}
            {hasRelativePath && (
              <div className="form-hint" style={{ color: 'var(--color-warning, #c8960a)' }}>
                Use an absolute path (starting with / or ~).
              </div>
            )}
            {argInput.hint && <div className="form-hint">{argInput.hint}</div>}
          </div>
        )
      })}

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
  onConnect,
  disabled
}: {
  deviceFlow: DeviceFlowStart | null
  oauthToken: string | null
  connecting: boolean
  polling: boolean
  onConnect: () => void
  disabled?: boolean
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
      disabled={connecting || disabled}
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
  onConnect,
  disabled
}: {
  providerName: string
  oauthToken: string | null
  connecting: boolean
  onConnect: () => void
  disabled?: boolean
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
      disabled={connecting || disabled}
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

// ─── Phase C: Import from Claude Code ────────────────────────────────────────

function ImportPanel({
  existingNames,
  onBack,
  onAdd
}: {
  existingNames: string[]
  onBack: () => void
  onAdd: (srv: McpServerConfig) => Promise<void> | void
}): React.ReactElement {
  const [detected, setDetected] = useState<DetectedMcpServer[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  useEffect(() => {
    window.electron.setup.detectClaudeMcp()
      .then((servers) => {
        const filtered = servers.filter((s) => !existingNames.includes(s.name))
        setDetected(filtered)
        // Pre-select all supported servers
        setSelected(new Set(filtered.filter((s) => s.supported).map((s) => s.name)))
      })
      .catch(() => setError('Could not read ~/.claude.json'))
      .finally(() => setLoading(false))
  }, [])

  const toggle = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const handleImport = async () => {
    setImporting(true)
    setError('')
    const toImport = detected.filter((s) => s.supported && selected.has(s.name))
    const imported: string[] = []
    try {
      for (const s of toImport) {
        await onAdd({
          name: s.name,
          command: s.command!,
          args: s.args,
          env: s.env && Object.keys(s.env).length ? s.env : undefined
        })
        imported.push(s.name)
      }
      setDone(true)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Import failed'
      const suffix = imported.length > 0
        ? ` (${imported.length} of ${toImport.length} imported: ${imported.join(', ')})`
        : ''
      setError(msg + suffix)
    } finally {
      setImporting(false)
    }
  }

  const supportedCount = detected.filter((s) => s.supported).length
  const selectedCount = [...selected].filter((n) => detected.find((d) => d.name === n && d.supported)).length

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <button className="btn btn--ghost btn--sm" onClick={onBack} style={{ padding: '4px 6px' }}>
          <ArrowLeft size={14} />
        </button>
        <div>
          <div style={{ fontWeight: 600, fontSize: 14 }}>Import from Claude Code</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Global MCP servers from ~/.claude.json</div>
        </div>
      </div>

      {error && <div className="alert alert--error" style={{ marginBottom: 10 }}>{error}</div>}

      {loading && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6, padding: '12px 0' }}>
          <span className="spinner" style={{ width: 12, height: 12 }} />
          Scanning Claude Code config…
        </div>
      )}

      {!loading && detected.length === 0 && !error && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: '16px 0' }}>
          No new servers found in your Claude Code config.
        </div>
      )}

      {!loading && done && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--color-success, #22c55e)', fontSize: 13, marginBottom: 10 }}>
          <Check size={14} />
          {selectedCount} server{selectedCount !== 1 ? 's' : ''} imported successfully
        </div>
      )}

      {!loading && detected.length > 0 && !done && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {detected.map((srv) => (
            <label
              key={srv.name}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                padding: '8px 10px',
                borderRadius: 'var(--radius-md)',
                background: 'var(--bg-elevated)',
                cursor: srv.supported ? 'pointer' : 'default',
                opacity: srv.supported ? 1 : 0.5
              }}
            >
              <input
                type="checkbox"
                checked={srv.supported && selected.has(srv.name)}
                disabled={!srv.supported}
                onChange={() => srv.supported && toggle(srv.name)}
                style={{ marginTop: 2, flexShrink: 0 }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6 }}>
                  {srv.name}
                  {!srv.supported && (
                    <span style={{ fontSize: 10, color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: 4, padding: '1px 5px' }}>
                      {srv.type} — unsupported
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {srv.command ? [srv.command, ...(srv.args ?? [])].join(' ') : srv.type}
                </div>
                {srv.env && Object.keys(srv.env).length > 0 && (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                    {Object.keys(srv.env).length} env var{Object.keys(srv.env).length !== 1 ? 's' : ''} included
                  </div>
                )}
              </div>
            </label>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 }}>
        <button className="btn btn--ghost btn--sm" onClick={onBack}>
          {done ? 'Done' : 'Back'}
        </button>
        {!done && supportedCount > 0 && (
          <button
            className="btn btn--primary btn--sm"
            onClick={handleImport}
            disabled={importing || selectedCount === 0}
          >
            {importing ? <span className="spinner" /> : `Import ${selectedCount > 0 ? selectedCount : ''} server${selectedCount !== 1 ? 's' : ''}`}
          </button>
        )}
      </div>
    </div>
  )
}
