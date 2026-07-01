import React, { useState, useEffect, useMemo, useCallback } from 'react'
import { Check, AlertTriangle, XCircle, RefreshCw, Wand2, Trash2, User, Power, ChevronDown, ChevronRight } from 'lucide-react'
import type { AppConfig, McpServerConfig, McpServerStatus, OAuthAppCredential, OAuthProvider, SetupHealth, DeviceFlowStart, AutonomyPolicy, Tier, IntentType, ResolvedOwnerHandles, GraphNode, GraphEdge, Memory } from '@shared/types'
import { MCP_CATALOG } from '@shared/mcp-catalog'
import { SCOPE_SURFACES } from '@shared/scope-surfaces'
import ServerCatalogPicker from './ServerCatalogPicker'
import { ScheduleBuilder } from './ScheduleBuilder'
import { useToast } from '../toast/ToastProvider'

const OWNER_SURFACES = ['github', 'slack', 'jira', 'linear', 'notion'] as const
type OwnerSurface = typeof OWNER_SURFACES[number]

export default function Settings(): React.ReactElement {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [status, setStatus] = useState<McpServerStatus[]>([])
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [showNewServer, setShowNewServer] = useState(false)
  const [testing, setTesting] = useState<Record<string, boolean>>({})
  const [rowError, setRowError] = useState<Record<string, string>>({})
  const [health, setHealth] = useState<SetupHealth | null>(null)
  const [healthLoading, setHealthLoading] = useState(false)
  const [oauthState, setOauthState] = useState<{
    serverName: string
    deviceFlow: DeviceFlowStart | null
    polling: boolean
    error: string
  } | null>(null)
  const [autoFilling, setAutoFilling] = useState(false)
  const [handleStatus, setHandleStatus] = useState<ResolvedOwnerHandles>({})
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [apiKeyStatus, setApiKeyStatus] = useState<{ configured: boolean; preview: string | null }>({ configured: false, preview: null })
  const [expandedServers, setExpandedServers] = useState<Set<string>>(new Set())

  const api = window.electron
  const toast = useToast()

  // Sync display state after config mutations — reads current connection Map without re-probing.
  const syncDisplay = useCallback(async () => {
    const [newStatus, newHealth] = await Promise.all([
      api.config.getMcpStatus(),
      api.setup.getHealth()
    ])
    setStatus(newStatus)
    setHealth(newHealth)
    // Clear row errors for any server that is now connected so stale failure
    // alerts don't persist after a successful save/add/reconnect.
    setRowError((prev) => {
      const next = { ...prev }
      for (const s of newStatus) {
        if (s.connected) delete next[s.name]
      }
      return next
    })
  }, [api])

  // Re-check button — fully re-connects all servers then reads health.
  const refreshHealth = useCallback(async () => {
    setHealthLoading(true)
    try {
      const newStatus = await api.config.reconnectAll()
      setStatus(newStatus)
      setHealth(await api.setup.getHealth())
    } finally {
      setHealthLoading(false)
    }
  }, [api])

  useEffect(() => {
    api.config.get().then(setConfig)
    api.config.getMcpStatus().then(setStatus)
    api.config.getClaudeKey().then(setApiKeyStatus)
    api.setup.getHealth().then(setHealth)
  }, [])

  const usedProviders = useMemo(() => {
    const providers = new Set<OAuthProvider>()
    for (const srv of config?.mcp_servers ?? []) {
      const entry = MCP_CATALOG.find((e) => e.id === srv.name)
      if (entry?.oauthProvider) providers.add(entry.oauthProvider as OAuthProvider)
    }
    return providers
  }, [config?.mcp_servers])

  const visibleSurfaces = useMemo(
    () => OWNER_SURFACES.filter((s) => (config?.mcp_servers ?? []).some((m) => m.name === s)),
    [config?.mcp_servers]
  )

  if (!config) return <div style={{ padding: 24, color: 'var(--text-muted)' }}>Loading…</div>

  const handleSave = async () => {
    setSaving(true)
    try {
      await api.config.update(config)
      // Save API key if the user typed a new one
      if (apiKeyInput.trim()) {
        await api.config.setClaudeKey(apiKeyInput.trim())
        setApiKeyInput('')
        setApiKeyStatus(await api.config.getClaudeKey())
      }
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
      await syncDisplay()
      toast.success('Settings saved')
    } catch (err: any) {
      toast.error('Failed to save settings', { message: err?.message })
    } finally {
      setSaving(false)
    }
  }

  const handleRemoveApiKey = async () => {
    try {
      await api.config.setClaudeKey(null)
      setApiKeyInput('')
      setApiKeyStatus({ configured: false, preview: null })
      toast.success('API key removed')
    } catch (err: any) {
      toast.error('Failed to remove API key', { message: err?.message })
    }
  }

  const handleAddServer = async (srv: McpServerConfig) => {
    if (saving) return
    setSaving(true)
    setTesting((prev) => ({ ...prev, [srv.name]: true }))
    try {
      const updated = { ...config, mcp_servers: [...config.mcp_servers, srv] }
      setConfig(updated)
      setShowNewServer(false)
      await api.config.update(updated)
      await syncDisplay()
      toast.success(`Server "${srv.name}" added`)
      // Silently try to detect identity for this surface. config:update already
      // connected the server so resolveOwnerHandles can reach it immediately.
      if ((OWNER_SURFACES as readonly string[]).includes(srv.name)) {
        const surface = srv.name as OwnerSurface
        api.setup.resolveOwnerHandles().then((resolved) => {
          const entry = resolved[surface]
          if (!entry) return
          if (updated.owner?.handles?.[surface]) return  // user already set one
          setConfig((prev) => {
            if (!prev) return prev
            return {
              ...prev,
              owner: {
                ...(prev.owner ?? {}),
                handles: { ...(prev.owner?.handles ?? {}), [surface]: entry.value }
              }
            }
          })
          setHandleStatus((prev) => ({ ...prev, [surface]: entry }))
          if (entry.needsReview) {
            toast.info(`Detected your ${srv.name} identity — review it in About You`)
          } else {
            toast.success(`Detected your ${srv.name} identity: ${entry.value}`)
          }
        }).catch(() => {})
      }
    } catch (err: any) {
      toast.error('Failed to add server', { message: err?.message })
    } finally {
      setTesting((prev) => { const next = { ...prev }; delete next[srv.name]; return next })
      setSaving(false)
    }
  }

  const handleRemoveServer = async (name: string) => {
    try {
      const updated = { ...config, mcp_servers: config.mcp_servers.filter((s) => s.name !== name) }
      setConfig(updated)
      await api.config.update(updated)
      await syncDisplay()
      toast.success(`Server "${name}" removed`)
    } catch (err: any) {
      toast.error('Failed to remove server', { message: err?.message })
    }
  }

  const handleToggleServer = async (name: string) => {
    const srv = config.mcp_servers.find((s) => s.name === name)
    if (!srv) return
    const nowEnabled = srv.enabled !== false  // currently enabled → will disable
    try {
      const updated = {
        ...config,
        mcp_servers: config.mcp_servers.map((s) =>
          s.name !== name ? s : { ...s, enabled: !nowEnabled }
        )
      }
      setConfig(updated)
      await api.config.update(updated)
      await syncDisplay()
      toast.success(`Server "${name}" ${nowEnabled ? 'disabled' : 'enabled'}`)
    } catch (err: any) {
      toast.error('Failed to update server', { message: err?.message })
    }
  }

  const handleTestServer = async (srv: McpServerConfig) => {
    setTesting((prev) => ({ ...prev, [srv.name]: true }))
    setRowError((prev) => { const next = { ...prev }; delete next[srv.name]; return next })
    try {
      const st = await api.config.reconnectMcpServer(srv.name)
      setStatus((prev) => [...prev.filter((s) => s.name !== st.name), st])
      if (st.connected) {
        toast.success(`${srv.name}: connected (${st.tools.length} tools)`)
      } else {
        setRowError((prev) => ({ ...prev, [srv.name]: st.error ?? 'Connection failed' }))
      }
    } catch (err: any) {
      setRowError((prev) => ({ ...prev, [srv.name]: err?.message ?? 'Unknown error' }))
    } finally {
      setTesting((prev) => { const next = { ...prev }; delete next[srv.name]; return next })
    }
  }

  const handleOAuthReconnect = async (srv: McpServerConfig) => {
    const entry = MCP_CATALOG.find((e) => e.id === srv.name)
    if (!entry?.oauthTokenEnvKey) return
    setOauthState({ serverName: srv.name, deviceFlow: null, polling: false, error: '' })
    try {
      const flow = await api.oauth.startDevice()
      setOauthState({ serverName: srv.name, deviceFlow: flow, polling: true, error: '' })
      api.oauth.pollDevice(flow.deviceCode)
        .then(async (token) => {
          const tokenKey = entry.oauthTokenEnvKey!
          const updatedServers = config!.mcp_servers.map((s) =>
            s.name !== srv.name ? s : { ...s, env: { ...(s.env ?? {}), [tokenKey]: token } }
          )
          const updated = { ...config!, mcp_servers: updatedServers }
          setConfig(updated)
          await api.config.update(updated)
          setOauthState(null)
          await syncDisplay()
          toast.success(`${srv.name} connected`)
        })
        .catch((err: Error) =>
          setOauthState((prev) => prev ? { ...prev, deviceFlow: null, polling: false, error: err.message } : null)
        )
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Connection failed'
      setOauthState((prev) => prev ? { ...prev, error: msg } : null)
    }
  }

  const handleAutoFillOwner = async () => {
    setAutoFilling(true)
    try {
      const resolved = await api.setup.resolveOwnerHandles()
      setHandleStatus(resolved)
      const found = Object.keys(resolved).length
      if (found === 0) {
        toast.info('No identity tools found', { message: 'No identity tools found on connected servers — fill in your handles manually.' })
      } else {
        const reviewCount = Object.values(resolved).filter((e) => e?.needsReview).length
        if (reviewCount > 0) {
          toast.success(`Found ${found} handle${found === 1 ? '' : 's'}`, {
            message: `${reviewCount} ${reviewCount === 1 ? 'handle' : 'handles'} marked for review — may not match your graph.`
          })
        } else {
          toast.success(`Found ${found} handle${found === 1 ? '' : 's'}`)
        }
        const currentHandles = config.owner?.handles ?? {}
        const mergedHandles = { ...currentHandles }
        for (const [surface, entry] of Object.entries(resolved) as [keyof typeof resolved, typeof resolved[keyof typeof resolved]][]) {
          if (entry && !currentHandles[surface]) {
            mergedHandles[surface] = entry.value
          }
        }
        setConfig({ ...config, owner: { ...(config.owner ?? {}), handles: mergedHandles } })
      }
    } finally {
      setAutoFilling(false)
    }
  }

  const setOAuthField = (
    provider: 'github' | 'notion' | 'linear',
    field: keyof OAuthAppCredential,
    value: string
  ) => {
    setConfig({
      ...config,
      oauth_apps: {
        ...config.oauth_apps,
        [provider]: {
          clientId: '',
          ...(config.oauth_apps?.[provider] ?? {}),
          [field]: value
        }
      }
    })
  }

  const handleCredentialSave = async (provider: OAuthProvider, creds: OAuthAppCredential) => {
    try {
      await api.config.update({
        oauth_apps: { [provider]: creds } as Partial<AppConfig>['oauth_apps'],
        oauth_connected_at: { [provider]: new Date().toISOString() } as Partial<AppConfig>['oauth_connected_at']
      } as Partial<AppConfig>)
      setConfig({ ...config, oauth_apps: { ...config.oauth_apps, [provider]: creds } })
      await syncDisplay()
      toast.success(`${provider} credentials saved`)
    } catch (err: any) {
      toast.error('Failed to save credentials', { message: err?.message })
    }
  }

  return (
    <div>
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div className="page-title">Settings</div>
            <div className="page-subtitle">Configure your assistant and integrations</div>
          </div>
          <button className="btn btn--primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : saved ? 'Saved' : 'Save changes'}
          </button>
        </div>
      </div>

      {/* Setup Health */}
      <HealthCard health={health} loading={healthLoading} onRefresh={refreshHealth} />

      {/* About You — identity hub */}
      <div className="card">
        <div className="card__header">
          <div>
            <div className="card__title">About You</div>
            <div className="card__subtitle">Identity, working context, and what mypa has learned.</div>
          </div>
          {visibleSurfaces.length > 0 && (
            <button
              className="btn btn--ghost btn--sm"
              onClick={handleAutoFillOwner}
              disabled={autoFilling}
              style={{ display: 'flex', alignItems: 'center', gap: 5 }}
              title="Pre-fill handles from connected MCP tools"
            >
              {autoFilling ? <span className="spinner" /> : <Wand2 size={12} />}
              {autoFilling ? 'Resolving…' : 'Auto-fill'}
            </button>
          )}
        </div>

        {/* ── Identity ── */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 10 }}>
            Identity
          </div>

          {/* Name row with monogram */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <div style={{
              width: 36, height: 36, borderRadius: '50%',
              background: 'var(--bg-elevated)', border: '1px solid var(--border-muted)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0, fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)',
              userSelect: 'none'
            }}>
              {config.owner?.name
                ? config.owner.name.trim().split(/\s+/).slice(0, 2).map((w) => w[0].toUpperCase()).join('')
                : <User size={16} strokeWidth={1.5} />}
            </div>
            <div style={{ flex: 1 }}>
              <input
                className="form-input"
                type="text"
                placeholder="Your name"
                value={config.owner?.name ?? ''}
                onChange={(e) => setConfig({ ...config, owner: { ...(config.owner ?? {}), name: e.target.value } })}
              />
            </div>
          </div>
          <div className="form-hint" style={{ marginBottom: 0 }}>How the assistant refers to you in summaries.</div>
        </div>

        {/* ── Connected Accounts ── */}
        <div style={{ marginBottom: 0 }}>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 10 }}>
            Connected Accounts
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {OWNER_SURFACES.map((surface) => {
              const connected = visibleSurfaces.includes(surface)
              const surfaceStatus = handleStatus[surface]
              const abbrev = surface.slice(0, 2).replace(/^(.)/, (c) => c.toUpperCase())
              return (
                <div key={surface} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  {/* Surface badge */}
                  <div style={{
                    width: 28, height: 28, borderRadius: 6,
                    background: 'var(--bg-elevated)', border: '1px solid var(--border-muted)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    flexShrink: 0, fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)',
                    userSelect: 'none', opacity: connected ? 1 : 0.45
                  }}>
                    {abbrev}
                  </div>

                  {/* Surface label */}
                  <div style={{ width: 46, fontSize: 12, color: connected ? 'var(--text-primary)' : 'var(--text-muted)', textTransform: 'capitalize', flexShrink: 0 }}>
                    {surface}
                  </div>

                  {/* Handle input — editable only when surface is connected */}
                  {connected ? (
                    <input
                      className="form-input"
                      type="text"
                      placeholder={surface === 'jira' ? 'Display Name' : 'handle, handle2'}
                      value={config.owner?.handles?.[surface] ?? ''}
                      onChange={(e) => setConfig({
                        ...config,
                        owner: {
                          ...(config.owner ?? {}),
                          handles: { ...(config.owner?.handles ?? {}), [surface]: e.target.value }
                        }
                      })}
                      style={{
                        flex: 1,
                        ...(surfaceStatus?.needsReview ? { borderColor: 'var(--color-warning, #f59e0b)' } : {})
                      }}
                    />
                  ) : (
                    <div style={{ flex: 1, fontSize: 12, color: 'var(--text-muted)' }}>not connected</div>
                  )}

                  {/* Status pill */}
                  {connected && surfaceStatus && (
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 3, flexShrink: 0,
                      fontSize: 11, fontWeight: 500,
                      color: surfaceStatus.needsReview ? 'var(--color-warning, #f59e0b)' : 'var(--color-success, #22c55e)'
                    }}>
                      {surfaceStatus.needsReview
                        ? <AlertTriangle size={11} />
                        : <Check size={11} />}
                      {surfaceStatus.needsReview ? 'Confirm' : 'Verified'}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          {visibleSurfaces.length > 0 && (
            <div className="form-hint" style={{ marginTop: 8 }}>
              Used to recognise you in your connected surface data. Separate multiple handles with a comma.
            </div>
          )}
          {visibleSurfaces.length === 0 && (
            <div className="form-hint" style={{ marginTop: 8 }}>
              Add a GitHub, Slack, Jira, Linear, or Notion MCP server to configure your identity handles.
            </div>
          )}
        </div>

        {/* ── Working Context ── */}
        <WorkingContextSection />

        {/* ── What mypa has learned ── */}
        <LearnedProfileSection ownerHandles={config.owner?.handles} />
      </div>

      {/* Assistant Identity */}
      <div className="card">
        <div className="card__header">
          <div className="card__title">Assistant Identity</div>
        </div>
        <div className="form-group">
          <label className="form-label">Persona</label>
          <textarea
            className="form-input"
            rows={3}
            placeholder="A personal assistant. Be concise and action-oriented."
            value={config.persona ?? ''}
            onChange={(e) => setConfig({ ...config, persona: e.target.value })}
            style={{ resize: 'vertical', fontFamily: 'inherit' }}
          />
          <div className="form-hint">Describe how the assistant should present itself in conversations.</div>
        </div>
      </div>

      {/* Claude AI */}
      <div className="card">
        <div className="card__header">
          <div className="card__title">Claude AI</div>
        </div>
        <div className="form-group">
          <div className="form-hint" style={{ marginBottom: 12 }}>
            Powered by the Claude Agent SDK. mypa automatically selects the right model for each task — Haiku for quick classifications, Sonnet for summaries and chat, Opus for complex agentic work. Provide an Anthropic API key below, or leave blank to use ambient credentials (environment variables or an active Claude login session).
          </div>
        </div>
        <div className="form-group">
          <label className="form-label">Anthropic API Key</label>
          {apiKeyStatus.configured && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'monospace' }}>
                {apiKeyStatus.preview}
              </span>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={handleRemoveApiKey}
                style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--text-danger, #e53e3e)' }}
              >
                <Trash2 size={12} />
                Remove
              </button>
            </div>
          )}
          <input
            className="form-input"
            type="password"
            placeholder={apiKeyStatus.configured ? 'Enter a new key to replace' : 'sk-ant-…'}
            value={apiKeyInput}
            onChange={(e) => setApiKeyInput(e.target.value)}
            autoComplete="off"
          />
          <div className="form-hint">
            {apiKeyStatus.configured
              ? 'Leave blank to keep the current key. The key is encrypted at rest.'
              : 'Optional. Leave blank to use ambient credentials (env vars or an active Claude login session).'}
          </div>
        </div>
      </div>

      {/* OAuth App Credentials — only shown for providers used by configured servers */}
      {usedProviders.size > 0 && (
        <div className="card">
          <div className="card__header">
            <div>
              <div className="card__title">OAuth App Credentials</div>
              <div className="card__subtitle">App credentials for connected OAuth providers.</div>
            </div>
            <button
              className="btn btn--ghost btn--sm"
              onClick={async () => {
                for (const provider of Array.from(usedProviders) as OAuthProvider[]) {
                  const creds = config.oauth_apps?.[provider]
                  if (creds) await handleCredentialSave(provider, creds)
                }
              }}
            >
              Save
            </button>
          </div>

          {usedProviders.has('github') && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: 'var(--text-secondary)' }}>GitHub</div>
              <div className="form-group">
                <label className="form-label">Client ID</label>
                <input
                  className="form-input"
                  type="text"
                  placeholder="Ov23li…"
                  value={config.oauth_apps?.github?.clientId ?? ''}
                  onChange={(e) => setOAuthField('github', 'clientId', e.target.value)}
                />
              </div>
            </div>
          )}

          {usedProviders.has('notion') && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: 'var(--text-secondary)' }}>Notion</div>
              <div className="form-group">
                <label className="form-label">Client ID</label>
                <input
                  className="form-input"
                  type="text"
                  placeholder="your-client-id"
                  value={config.oauth_apps?.notion?.clientId ?? ''}
                  onChange={(e) => setOAuthField('notion', 'clientId', e.target.value)}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Client Secret</label>
                <input
                  className="form-input"
                  type="password"
                  placeholder="secret_…"
                  value={config.oauth_apps?.notion?.clientSecret ?? ''}
                  onChange={(e) => setOAuthField('notion', 'clientSecret', e.target.value)}
                />
              </div>
            </div>
          )}

          {usedProviders.has('linear') && (
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: 'var(--text-secondary)' }}>Linear</div>
              <div className="form-group">
                <label className="form-label">Client ID</label>
                <input
                  className="form-input"
                  type="text"
                  placeholder="your-client-id"
                  value={config.oauth_apps?.linear?.clientId ?? ''}
                  onChange={(e) => setOAuthField('linear', 'clientId', e.target.value)}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Client Secret</label>
                <input
                  className="form-input"
                  type="password"
                  placeholder="lin_oauth_…"
                  value={config.oauth_apps?.linear?.clientSecret ?? ''}
                  onChange={(e) => setOAuthField('linear', 'clientSecret', e.target.value)}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* MCP Servers */}
      <div className="card">
        <div className="card__header">
          <div>
            <div className="card__title">MCP Servers</div>
            <div className="card__subtitle">Local tool servers for GitHub, Jira, Gmail, etc.</div>
          </div>
          <button className="btn btn--ghost btn--sm" onClick={() => setShowNewServer(true)}>
            + Add server
          </button>
        </div>

        {config.mcp_servers.length === 0 && !showNewServer && (
          <div style={{ color: 'var(--text-muted)', fontSize: 12, padding: '8px 0' }}>
            No MCP servers configured. Add one to enable tool integrations.
          </div>
        )}

        {config.mcp_servers.map((srv) => {
          const isDisabled = srv.enabled === false
          const s = status.find((x) => x.name === srv.name)
          const entry = MCP_CATALOG.find((e) => e.id === srv.name)
          const srvHealth = health?.servers.find((h) => h.name === srv.name)
          const needsOAuth = !isDisabled && entry?.authType === 'oauth' && (srvHealth?.missingEnvKeys?.length ?? 0) > 0
          const oauthActive = oauthState?.serverName === srv.name
          const dotState = isDisabled ? 'disabled' : s?.connected ? 'connected' : 'disconnected'
          const hasTools = !isDisabled && (s?.tools.length ?? 0) > 0
          const isExpanded = expandedServers.has(srv.name)
          const toggleExpand = () => setExpandedServers((prev) => {
            const next = new Set(prev)
            if (next.has(srv.name)) next.delete(srv.name)
            else next.add(srv.name)
            return next
          })
          return (
            <React.Fragment key={srv.name}>
              <div className="mcp-server-row" style={isDisabled ? { opacity: 0.55 } : undefined}>
                <div
                  className={`mcp-server-row__dot mcp-server-row__dot--${dotState}`}
                />
                <div className="mcp-server-row__name">{srv.name}</div>
                <div
                  className="mcp-server-row__count"
                  style={hasTools ? { cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 3 } : undefined}
                  onClick={hasTools ? toggleExpand : undefined}
                  title={hasTools ? (isExpanded ? 'Hide tools' : 'Show tools') : undefined}
                >
                  {isDisabled
                    ? 'disabled'
                    : testing[srv.name]
                      ? 'connecting…'
                      : s?.connected
                        ? `${s.tools.length} tools`
                        : s
                          ? 'disconnected'
                          : 'unknown'}
                  {hasTools && (isExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />)}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {needsOAuth && (
                    <button
                      className="btn btn--primary btn--sm"
                      onClick={() => handleOAuthReconnect(srv)}
                      disabled={oauthActive}
                    >
                      {oauthActive && !oauthState?.deviceFlow ? <span className="spinner" /> : 'Connect'}
                    </button>
                  )}
                  {!isDisabled && (
                    <button
                      className="btn btn--ghost btn--sm"
                      onClick={() => handleTestServer(srv)}
                      disabled={!!testing[srv.name]}
                    >
                      {testing[srv.name] ? <span className="spinner" /> : 'Test connection'}
                    </button>
                  )}
                  <button
                    className="btn btn--ghost btn--sm"
                    title={isDisabled ? 'Enable server' : 'Disable server'}
                    onClick={() => handleToggleServer(srv.name)}
                    style={{ display: 'flex', alignItems: 'center', gap: 4 }}
                  >
                    <Power size={13} />
                    {isDisabled ? 'Enable' : 'Disable'}
                  </button>
                  <button className="btn btn--danger btn--sm" onClick={() => handleRemoveServer(srv.name)}>
                    Remove
                  </button>
                </div>
              </div>
              {rowError[srv.name] && (
                <div className="alert alert--error" style={{ marginTop: 4 }}>
                  {srv.name}: {rowError[srv.name]}
                </div>
              )}
              {oauthActive && oauthState!.error && (
                <div className="alert alert--error" style={{ marginTop: 6 }}>{oauthState!.error}</div>
              )}
              {oauthActive && oauthState!.deviceFlow && (
                <div style={{ background: 'var(--bg-elevated)', borderRadius: 'var(--radius-md)', padding: '10px 12px', marginTop: 6 }}>
                  <div style={{ fontSize: 13, marginBottom: 8 }}>
                    Enter this code at{' '}
                    <a
                      href={oauthState!.deviceFlow.verificationUri}
                      onClick={(e) => { e.preventDefault(); window.open(oauthState!.deviceFlow!.verificationUri) }}
                      style={{ color: 'var(--accent)' }}
                    >
                      {oauthState!.deviceFlow.verificationUri}
                    </a>
                  </div>
                  <div style={{ fontFamily: 'monospace', fontSize: 22, fontWeight: 700, letterSpacing: '0.15em', marginBottom: 8 }}>
                    {oauthState!.deviceFlow.userCode}
                  </div>
                  {oauthState!.polling && (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span className="spinner" style={{ width: 12, height: 12 }} />
                      Waiting for authorization…
                    </div>
                  )}
                </div>
              )}
              {hasTools && isExpanded && (
                <div className="mcp-tool-list">
                  {s!.tools.map((tool) => {
                    const schema = tool.inputSchema as { properties?: Record<string, { type?: string; description?: string }>; required?: string[] } | undefined
                    const props = schema?.properties ?? {}
                    const required = new Set(schema?.required ?? [])
                    const params = Object.entries(props)
                    return (
                      <div key={tool.name} className="mcp-tool-list__item">
                        <div className="mcp-tool-list__name">{tool.name}</div>
                        {tool.description && (
                          <div className="mcp-tool-list__desc">{tool.description}</div>
                        )}
                        {params.length > 0 && (
                          <div className="mcp-tool-list__params">
                            {params.map(([pName, pDef]) => (
                              <div key={pName} className="mcp-tool-list__param-row">
                                <span className="mcp-tool-list__param-name">{pName}</span>
                                <span className="mcp-tool-list__param-type">{pDef.type ?? 'any'}</span>
                                {required.has(pName) && (
                                  <span className="mcp-tool-list__param-required">required</span>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </React.Fragment>
          )
        })}

        {showNewServer && (
          <ServerCatalogPicker
            onAdd={handleAddServer}
            onCancel={() => setShowNewServer(false)}
            oauthCreds={config.oauth_apps}
            onCredentialSave={handleCredentialSave}
            existingNames={config.mcp_servers.map((s) => s.name)}
          />
        )}
      </div>

      {/* Preferences */}
      <div className="card">
        <div className="card__header">
          <div className="card__title">Preferences</div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {[
            { key: 'widget_always_on_top' as const, label: 'Widget always on top' },
            { key: 'notification_sound' as const, label: 'Notification sound' },
            { key: 'launch_on_login' as const, label: 'Launch on login' }
          ].map(({ key, label }) => (
            <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 13 }}>{label}</span>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={config.preferences[key]}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      preferences: { ...config.preferences, [key]: e.target.checked }
                    })
                  }
                />
                <span className="toggle__track" />
              </label>
            </div>
          ))}
        </div>
      </div>

      {/* Ambient Autonomy */}
      <AmbientAutonomyCard />

      {/* Check-in schedule */}
      <CheckInScheduleCard />

      {/* Danger Zone */}
      <DangerZoneCard />

      <div style={{ textAlign: 'center', padding: '8px 0 4px', color: 'var(--text-muted)', fontSize: 11 }}>
        mypa v{import.meta.env.VITE_APP_VERSION} · {import.meta.env.VITE_GIT_SHA}
      </div>
    </div>
  )
}

// ─── Ambient Autonomy Card ───────────────────────────────────────────────────

// 'suggestion' is excluded: inference no longer emits it (kept in the type for
// backward-compat with stored intents only). flag/digest use a binary Show/Mute
// control because the 4-tier scale has no meaning for informational intents.
const ACTION_TYPES: IntentType[] = ['action']
const INTENT_TYPES: IntentType[] = ['action', 'flag', 'digest']

const TIER_LABELS: Record<number, string> = { 0: 'Silent', 1: 'Notify', 2: 'Approve', 3: 'Locked' }
const TIER_HINTS: Record<number, string> = {
  0: 'Acts automatically without telling you',
  1: 'Acts, then tells you what it did',
  2: 'Always asks before doing anything',
  3: 'Never acts — you must initiate'
}

// Show/Mute labels and hints for informational intent types (flag/digest).
// Show → tier 1 (surface to Activity), Mute → tier 3 (suppress entirely).
const SHOW_MUTE_LABEL = (muted: boolean): string => (muted ? 'Mute' : 'Show')
const SHOW_MUTE_HINT = (muted: boolean): string =>
  muted
    ? 'Suppressed — won\'t appear anywhere'
    : 'Surfaced quietly in Activity. Never acts or interrupts.'

function AmbientAutonomyCard(): React.ReactElement {
  const api = window.electron
  const toast = useToast()
  const [policies, setPolicies] = useState<AutonomyPolicy[]>([])
  const [resetting, setResetting] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const [enabled, setEnabled] = useState(true)

  useEffect(() => {
    api.ambient.getPolicy().then((p) => setPolicies(p as AutonomyPolicy[]))
    api.config.get().then((cfg) => setEnabled(cfg.ambient?.enabled ?? true))
  }, [])

  async function handleToggleEnabled(next: boolean): Promise<void> {
    setEnabled(next)
    try {
      await api.config.update({ ambient: { enabled: next } } as any)
      toast.success(next ? 'Ambient intelligence enabled' : 'Ambient intelligence disabled')
    } catch (err: any) {
      setEnabled(!next) // revert
      toast.error('Failed to update ambient setting', { message: err?.message })
    }
  }

  function getTierForType(type: IntentType): Tier {
    // Match the intent-type-level policy exactly (e.g. action_type === 'action').
    // Per-surface:verb policies (e.g. 'github:comment') are earned autonomously
    // and are NOT displayed here — this control sets the per-type default tier.
    return (policies.find((p) => p.action_type === type)?.tier ?? 2) as Tier
  }

  async function handleSetTier(type: IntentType, tier: Tier): Promise<void> {
    try {
      await api.ambient.setTier(type, tier)
      const updated = await api.ambient.getPolicy()
      setPolicies(updated as AutonomyPolicy[])
      const label = ACTION_TYPES.includes(type)
        ? TIER_LABELS[tier]
        : SHOW_MUTE_LABEL(tier >= 3)
      toast.success(`${type} intents set to "${label}"`)
    } catch (err: any) {
      toast.error('Failed to update trust tier', { message: err?.message })
    }
  }

  async function handleReset(): Promise<void> {
    setResetting(true)
    try {
      await api.ambient.resetTrust()
      const updated = await api.ambient.getPolicy()
      setPolicies(updated as AutonomyPolicy[])
      setConfirmReset(false)
      toast.success('Trust history reset')
    } catch (err: any) {
      toast.error('Failed to reset trust', { message: err?.message })
    } finally {
      setResetting(false)
    }
  }

  return (
    <div className="card">
      <div className="card__header">
        <div>
          <div className="card__title">Ambient Autonomy</div>
          <div className="card__subtitle">Control how much the assistant can act on its own.</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {/* Master on/off toggle */}
          <label className="toggle" title={enabled ? 'Ambient is on — click to disable' : 'Ambient is off — click to enable'}>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => handleToggleEnabled(e.target.checked)}
            />
            <span className="toggle__track" />
          </label>
          {/* Reset trust */}
          {confirmReset ? (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Reset trust?</span>
              <button className="btn btn--ghost btn--sm" onClick={() => setConfirmReset(false)} style={{ padding: '3px 8px', fontSize: 11 }}>Cancel</button>
              <button className="btn btn--danger btn--sm" onClick={handleReset} disabled={resetting} style={{ padding: '3px 8px', fontSize: 11 }}>Reset</button>
            </div>
          ) : (
            <button
              className="btn btn--danger btn--sm"
              onClick={() => setConfirmReset(true)}
              style={{ padding: '3px 8px', fontSize: 11 }}
            >
              Reset trust
            </button>
          )}
        </div>
      </div>

      {!enabled && (
        <div style={{
          padding: '8px 12px', marginBottom: 8,
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 8,
          fontSize: 12,
          color: 'var(--text-muted)'
        }}>
          Ambient intelligence is off — mypa won't poll or surface anything.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, opacity: enabled ? 1 : 0.4, pointerEvents: enabled ? 'auto' : 'none', transition: 'opacity 200ms' }}>
        {INTENT_TYPES.map((type) => {
          const currentTier = getTierForType(type)
          const isAction = ACTION_TYPES.includes(type)
          const muted = !isAction && currentTier >= 3

          return (
            <div key={type}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontSize: 13, textTransform: 'capitalize' }}>{type}s</span>

                {isAction ? (
                  /* 4-tier segmented control for action intents */
                  <div style={{ display: 'flex', background: 'var(--bg-elevated)', borderRadius: 8, padding: 2, gap: 2 }}>
                    {([0, 1, 2, 3] as Tier[]).map((tier) => (
                      <button
                        key={tier}
                        onClick={() => handleSetTier(type, tier)}
                        style={{
                          padding: '3px 8px',
                          borderRadius: 6,
                          border: 'none',
                          cursor: 'pointer',
                          fontSize: 11,
                          fontFamily: 'var(--font-sans)',
                          fontWeight: currentTier === tier ? 600 : 400,
                          background: currentTier === tier ? 'var(--bg-overlay)' : 'transparent',
                          color: currentTier === tier ? 'var(--text-primary)' : 'var(--text-muted)',
                          transition: 'background var(--transition), color var(--transition)'
                        }}
                      >
                        {TIER_LABELS[tier]}
                      </button>
                    ))}
                  </div>
                ) : (
                  /* Binary Show/Mute control for informational intents (flag/digest) */
                  <div style={{ display: 'flex', background: 'var(--bg-elevated)', borderRadius: 8, padding: 2, gap: 2 }}>
                    {([false, true] as boolean[]).map((wantMute) => (
                      <button
                        key={String(wantMute)}
                        onClick={() => handleSetTier(type, wantMute ? 3 : 1)}
                        style={{
                          padding: '3px 8px',
                          borderRadius: 6,
                          border: 'none',
                          cursor: 'pointer',
                          fontSize: 11,
                          fontFamily: 'var(--font-sans)',
                          fontWeight: muted === wantMute ? 600 : 400,
                          background: muted === wantMute ? 'var(--bg-overlay)' : 'transparent',
                          color: muted === wantMute ? 'var(--text-primary)' : 'var(--text-muted)',
                          transition: 'background var(--transition), color var(--transition)'
                        }}
                      >
                        {SHOW_MUTE_LABEL(wantMute)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {isAction ? TIER_HINTS[currentTier] : SHOW_MUTE_HINT(muted)}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Health Card ──────────────────────────────────────────────────────────────

function HealthCard({
  health,
  loading,
  onRefresh
}: {
  health: SetupHealth | null
  loading: boolean
  onRefresh: () => void
}): React.ReactElement | null {
  if (!health && !loading) return null

  const issues = health
    ? [
        !health.auth.ok,
        ...health.servers.map(
          (s) =>
            s.missingEnvKeys.length > 0 ||
            (s.invalidArgs?.length ?? 0) > 0 ||
            (s.oauthStaleDays ?? 0) > 60
        )
      ].filter(Boolean)
    : []

  const allOk = health && health.auth.ok && issues.length === 0

  return (
    <div className="card">
      <div className="card__header">
        <div>
          <div className="card__title">Setup Health</div>
          {allOk && <div className="card__subtitle">All systems ready</div>}
        </div>
        <button
          className="btn btn--ghost btn--sm"
          onClick={onRefresh}
          disabled={loading}
          style={{ display: 'flex', alignItems: 'center', gap: 4 }}
        >
          <RefreshCw size={12} className={loading ? 'spinning' : ''} />
          {loading ? 'Checking…' : 'Re-check'}
        </button>
      </div>

      {health && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {/* Claude auth row */}
          <HealthRow
            ok={health.auth.ok}
            label="Claude authentication"
            detail={
              health.auth.source === 'apikey' ? 'API key configured' :
              health.auth.source === 'env' ? 'Environment credentials' :
              health.auth.source === 'cli-login' ? 'Claude login session' :
              'Not configured'
            }
            action={
              !health.auth.ok ? (
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Add an API key above</span>
              ) : null
            }
          />

          {/* Per-server rows */}
          {health.servers.map((srv) => {
            const isStale = (srv.oauthStaleDays ?? 0) > 60
            const hasMissing = srv.missingEnvKeys.length > 0
            const hasInvalidArgs = (srv.invalidArgs?.length ?? 0) > 0
            const ok = !hasMissing && !hasInvalidArgs && !isStale

            let detail = 'Connected'
            if (hasMissing) detail = `Missing: ${srv.missingEnvKeys.join(', ')}`
            else if (hasInvalidArgs) detail = `Invalid directories: ${srv.invalidArgs!.join('; ')}`
            else if (isStale) detail = `OAuth last connected ${srv.oauthStaleDays} days ago`
            else if (!srv.connected) detail = 'Disconnected'

            return (
              <HealthRow
                key={srv.name}
                ok={ok && srv.connected}
                warn={!ok}
                label={srv.name}
                detail={detail}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

function HealthRow({
  ok,
  warn,
  label,
  detail,
  action
}: {
  ok: boolean
  warn?: boolean
  label: string
  detail: string
  action?: React.ReactNode
}): React.ReactElement {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0' }}>
      <div style={{ flexShrink: 0 }}>
        {ok ? (
          <Check size={14} color="var(--color-success, #22c55e)" />
        ) : warn ? (
          <AlertTriangle size={14} color="var(--color-warning, #f59e0b)" />
        ) : (
          <XCircle size={14} color="var(--color-error, #ef4444)" />
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 500 }}>{label}</span>
        <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 8 }}>{detail}</span>
      </div>
      {action && <div style={{ flexShrink: 0 }}>{action}</div>}
    </div>
  )
}

// ─── Check-in Schedule Card ──────────────────────────────────────────────────

function CheckInScheduleCard(): React.ReactElement {
  const api = window.electron
  const toast = useToast()
  const [enabled, setEnabled] = useState(false)
  const [schedule, setSchedule] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api.config.get().then((cfg) => {
      setEnabled(cfg.checkin?.scheduleEnabled ?? false)
      setSchedule(cfg.checkin?.schedule ?? '')
    })
  }, [])

  async function handleToggleEnabled(next: boolean): Promise<void> {
    setEnabled(next)
    try {
      await api.config.update({ checkin: { scheduleEnabled: next, schedule: schedule || undefined } } as any)
      toast.success(next ? 'Scheduled check-ins enabled' : 'Scheduled check-ins disabled')
    } catch (err: any) {
      setEnabled(!next)
      toast.error('Failed to update check-in schedule', { message: err?.message })
    }
  }

  async function handleSaveSchedule(): Promise<void> {
    setSaving(true)
    try {
      await api.config.update({ checkin: { scheduleEnabled: enabled, schedule: schedule || undefined } } as any)
      toast.success('Check-in schedule saved')
    } catch (err: any) {
      toast.error('Failed to save schedule', { message: err?.message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="card">
      <div className="card__header">
        <div>
          <div className="card__title">Check-in Schedule</div>
          <div className="card__subtitle">Automatically prompt for periodic 1:1 sessions</div>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 13 }}>Enable scheduled check-ins</span>
          <label className="toggle">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => handleToggleEnabled(e.target.checked)}
            />
            <span className="toggle__track" />
          </label>
        </div>

        {enabled && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <ScheduleBuilder cron={schedule || '0 9 * * 1'} onChange={setSchedule} />
            <button
              className="btn btn--primary"
              style={{ alignSelf: 'flex-end', fontSize: 12, padding: '5px 12px' }}
              onClick={handleSaveSchedule}
              disabled={saving}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── About You: Working Context sub-section ──────────────────────────────────

/**
 * Editable scope allowlists embedded inside the About You identity hub.
 * Candidates are derived from orgs/projects/channels already observed in the
 * knowledge graph, unioned with any already-configured identifiers.
 * Toggles save immediately to config.scope.allowed.
 */
function WorkingContextSection(): React.ReactElement {
  const api = window.electron
  // Current saved allowlist — the source of truth for "selected" state
  const [allowed, setAllowed] = useState<Record<string, string[]>>({})
  // Graph-derived candidates per surface (union with current allowed)
  const [candidates, setCandidates] = useState<Record<string, string[]>>({})
  const [enabledIntegrationIds, setEnabledIntegrationIds] = useState<string[]>([])

  useEffect(() => {
    api.config.get().then((cfg) => {
      setAllowed(cfg.scope?.allowed ?? {})
      setEnabledIntegrationIds((cfg.mcp_servers ?? []).map((s) => s.name))
    })
    api.config.getScopeCandidates().then(setCandidates)
  }, [])

  const enabledSurfaces = SCOPE_SURFACES.filter((s) => enabledIntegrationIds.includes(s.integrationId))

  function handleToggle(surface: string, id: string): void {
    // Use functional setState so rapid consecutive toggles always read the
    // latest state rather than the stale closure value.
    setAllowed((prev) => {
      const lower = id.toLowerCase()
      const current = (prev[surface] ?? []).map((s) => s.toLowerCase())
      const nextList = current.includes(lower)
        ? (prev[surface] ?? []).filter((s) => s.toLowerCase() !== lower)
        : [...(prev[surface] ?? []), id.toLowerCase()]
      // Send the full allowed map — deepMerge replaces arrays as leaves
      const nextAllowed = { ...prev, [surface]: nextList }
      api.config.update({ scope: { allowed: nextAllowed } }).catch(console.error)
      return nextAllowed
    })
  }

  return (
    <>
      <div style={{ borderTop: '1px solid var(--border-muted)', margin: '18px 0' }} />
      <div>
        <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 10 }}>
          Working Context
        </div>
        <div className="form-hint" style={{ marginBottom: 12 }}>
          Pick which {enabledSurfaces.length === 1 ? enabledSurfaces[0].itemNoun + 's' : 'orgs, projects, or channels'} mypa should focus on. Drawn from your recent activity.
        </div>

        {enabledSurfaces.length === 0 ? (
          <div className="form-hint">
            Connect GitHub, Jira, or Slack to enable scope filtering.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {enabledSurfaces.map((spec) => {
              const surfaceCandidates = candidates[spec.surface] ?? []
              const selectedLower = new Set((allowed[spec.surface] ?? []).map((s) => s.toLowerCase()))
              return (
                <div key={spec.surface}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 5 }}>
                    {spec.label}
                  </div>
                  {surfaceCandidates.length === 0 ? (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>
                      No {spec.itemNoun}s observed yet — unfiltered until you&apos;ve worked across connected {spec.integrationId}
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {surfaceCandidates.map((id) => {
                        const selected = selectedLower.has(id.toLowerCase())
                        return (
                          <button
                            key={id}
                            className={`btn btn--sm ${selected ? 'btn--primary' : 'btn--ghost'}`}
                            onClick={() => handleToggle(spec.surface, id)}
                          >
                            {id}
                          </button>
                        )
                      })}
                    </div>
                  )}
                  {surfaceCandidates.length > 0 && selectedLower.size === 0 && (
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, fontStyle: 'italic' }}>
                      None selected — all {spec.itemNoun}s pass through
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </>
  )
}

// ─── About You: Learned Profile sub-section ───────────────────────────────────

type LearnedProfileProps = {
  ownerHandles: Record<string, string> | undefined
}

/**
 * Read-only summary of what mypa has learned about the user from the knowledge
 * graph and stored memories. Derived entirely client-side from existing IPC.
 *
 * Owner identification: matches person nodes by key `${surface}:person:${handle}`
 * (the format used by memory-graph.ts when creating person nodes from signals).
 */
function LearnedProfileSection({ ownerHandles }: LearnedProfileProps): React.ReactElement {
  const api = window.electron
  const [loading, setLoading] = useState(true)
  const [activeIn, setActiveIn] = useState<string[]>([])
  const [worksWith, setWorksWith] = useState<string[]>([])
  const [prefers, setPrefers] = useState<string[]>([])
  const [hasOwnerFootprint, setHasOwnerFootprint] = useState(false)

  // Serialize handles to a stable string so the effect only re-fires when
  // values actually change, not on every parent re-render that produces a new
  // object reference.
  const handlesKey = ownerHandles ? JSON.stringify(ownerHandles) : ''

  useEffect(() => {
    if (!ownerHandles) {
      setLoading(false)
      return
    }

    Promise.all([
      api.memory.getGraph(),
      api.memory.getActive(100)
    ]).then(([graph, memories]: [{ nodes: GraphNode[]; edges: GraphEdge[] }, Memory[]]) => {
      const { nodes, edges } = graph

      // Build lookup maps for fast traversal
      const nodeById = new Map<string, GraphNode>(nodes.map((n) => [n.id, n]))

      // Identify owner node ids: person nodes whose key matches a configured handle
      const ownerIds = new Set<string>()
      for (const [surface, rawHandle] of Object.entries(ownerHandles)) {
        for (const handle of rawHandle.split(',').map((h) => h.trim()).filter(Boolean)) {
          const key = `${surface}:person:${handle}`
          const match = nodes.find((n) => n.type === 'person' && n.key === key)
          if (match) ownerIds.add(match.id)
        }
      }

      if (ownerIds.size === 0) {
        setHasOwnerFootprint(false)
        setLoading(false)
        return
      }
      setHasOwnerFootprint(true)

      // Collect all work-item ids the owner participates in (via participation edges)
      const PARTICIPATION_RELS = new Set(['authored', 'reviews', 'assigned_to', 'participates_in', 'mentioned_in'])
      const ownerWorkItemIds = new Set<string>()
      for (const e of edges) {
        if (ownerIds.has(e.src_id) && PARTICIPATION_RELS.has(e.rel)) ownerWorkItemIds.add(e.dst_id)
        if (ownerIds.has(e.dst_id) && PARTICIPATION_RELS.has(e.rel)) ownerWorkItemIds.add(e.src_id)
      }

      // Most-active containers: follow part_of edges from work items to repo/project/channel nodes
      const CONTAINER_TYPES = new Set(['repo', 'project', 'channel'])
      const containerWeight = new Map<string, number>()
      for (const e of edges) {
        if (e.rel !== 'part_of') continue
        if (!ownerWorkItemIds.has(e.src_id)) continue
        const container = nodeById.get(e.dst_id)
        if (!container || !CONTAINER_TYPES.has(container.type)) continue
        containerWeight.set(container.id, (containerWeight.get(container.id) ?? 0) + (container.weight ?? 1))
      }
      const topContainers = [...containerWeight.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([id]) => nodeById.get(id)?.label ?? id)
      setActiveIn(topContainers)

      // Top collaborators: person nodes sharing a work item with the owner
      const collabWeight = new Map<string, number>()
      for (const e of edges) {
        if (!PARTICIPATION_RELS.has(e.rel)) continue
        // Other person acting on an owner work item
        if (ownerWorkItemIds.has(e.dst_id) && !ownerIds.has(e.src_id)) {
          const person = nodeById.get(e.src_id)
          if (person?.type === 'person') {
            collabWeight.set(person.id, (collabWeight.get(person.id) ?? 0) + (person.weight ?? 1))
          }
        }
        if (ownerWorkItemIds.has(e.src_id) && !ownerIds.has(e.dst_id)) {
          const person = nodeById.get(e.dst_id)
          if (person?.type === 'person') {
            collabWeight.set(person.id, (collabWeight.get(person.id) ?? 0) + (person.weight ?? 1))
          }
        }
      }
      const topCollabs = [...collabWeight.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([id]) => nodeById.get(id)?.label ?? id)
      setWorksWith(topCollabs)

      // Learned preferences: preference/pattern memories or hard-enforcement rules
      const prefMemories = memories
        .filter((m) => m.type === 'preference' || m.type === 'pattern' || m.enforcement === 'hard')
        .sort((a, b) => (b.importance - a.importance) || (b.confidence - a.confidence))
        .slice(0, 3)
        .map((m) => m.content)
      setPrefers(prefMemories)
    }).catch((err) => {
      console.error('[LearnedProfileSection] graph/memory fetch failed:', err)
    }).finally(() => {
      setLoading(false)
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handlesKey])

  const isEmpty = !hasOwnerFootprint && activeIn.length === 0 && worksWith.length === 0 && prefers.length === 0

  return (
    <>
      <div style={{ borderTop: '1px solid var(--border-muted)', margin: '18px 0' }} />
      <div>
        <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 10 }}>
          What mypa has learned
        </div>

        {loading ? (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="spinner" style={{ width: 12, height: 12 }} />
            Loading…
          </div>
        ) : isEmpty ? (
          <div className="form-hint">
            mypa hasn't learned enough yet — this fills in as it observes your activity over time.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {activeIn.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <div style={{ width: 70, fontSize: 12, color: 'var(--text-muted)', flexShrink: 0, paddingTop: 2 }}>Active in</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {activeIn.map((label) => (
                    <span key={label} style={{ display: 'inline-flex', alignItems: 'center', padding: '2px 7px', borderRadius: 4, fontSize: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-muted)' }}>
                      {label}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {worksWith.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <div style={{ width: 70, fontSize: 12, color: 'var(--text-muted)', flexShrink: 0, paddingTop: 2 }}>Works with</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {worksWith.map((label) => (
                    <span key={label} style={{ display: 'inline-flex', alignItems: 'center', padding: '2px 7px', borderRadius: 4, fontSize: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-muted)' }}>
                      {label}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {prefers.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <div style={{ width: 70, fontSize: 12, color: 'var(--text-muted)', flexShrink: 0, paddingTop: 2 }}>Prefers</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {prefers.map((content, i) => (
                    <div key={i} style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                      {content}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  )
}

// ─── Danger Zone Card ────────────────────────────────────────────────────────

function DangerZoneCard(): React.ReactElement {
  const api = window.electron
  const toast = useToast()
  const [confirm, setConfirm] = useState(false)
  const [resetting, setResetting] = useState(false)

  async function handleFactoryReset(): Promise<void> {
    setResetting(true)
    try {
      await api.system.factoryReset()
      // App relaunches immediately — this line is rarely reached
    } catch (err: any) {
      setResetting(false)
      setConfirm(false)
      toast.error('Factory reset failed', { message: err?.message })
    }
  }

  return (
    <div className="card">
      <div className="card__header">
        <div>
          <div className="card__title" style={{ color: 'var(--text-danger)' }}>
            <AlertTriangle size={14} style={{ display: 'inline', marginRight: 6, verticalAlign: 'text-bottom' }} />
            Danger Zone
          </div>
          <div className="card__subtitle">
            Irreversible actions — proceed with caution.
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', marginBottom: 2 }}>
            Factory reset
          </div>
          <div className="form-hint">
            Erases all routines, memories, signals, MCP/OAuth setup, and preferences, then relaunches the app.
          </div>
        </div>
        {confirm ? (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Are you sure?</span>
            <button
              className="btn btn--ghost btn--sm"
              onClick={() => setConfirm(false)}
              style={{ padding: '3px 8px', fontSize: 11 }}
              disabled={resetting}
            >
              Cancel
            </button>
            <button
              className="btn btn--danger btn--sm"
              onClick={handleFactoryReset}
              disabled={resetting}
              style={{ padding: '3px 8px', fontSize: 11 }}
            >
              {resetting ? 'Resetting…' : 'Reset everything'}
            </button>
          </div>
        ) : (
          <button
            className="btn btn--danger btn--sm"
            onClick={() => setConfirm(true)}
            style={{ flexShrink: 0 }}
          >
            Factory reset
          </button>
        )}
      </div>
    </div>
  )
}
