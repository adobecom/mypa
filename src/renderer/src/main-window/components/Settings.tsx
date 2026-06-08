import React, { useState, useEffect, useMemo, useCallback } from 'react'
import { Check, AlertTriangle, XCircle, RefreshCw, Wand2 } from 'lucide-react'
import type { AppConfig, McpServerConfig, McpServerStatus, OAuthAppCredential, OAuthProvider, SetupHealth, DeviceFlowStart, AutonomyPolicy, Tier, IntentType, ResolvedOwnerHandles } from '@shared/types'
import { MCP_CATALOG } from '@shared/mcp-catalog'
import ServerCatalogPicker from './ServerCatalogPicker'
import { useToast } from '../toast/ToastProvider'

const OWNER_SURFACES = ['github', 'slack', 'jira', 'linear', 'notion'] as const
type OwnerSurface = typeof OWNER_SURFACES[number]

export default function Settings(): React.ReactElement {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [status, setStatus] = useState<McpServerStatus[]>([])
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [showNewServer, setShowNewServer] = useState(false)
  const [testing, setTesting] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<{ name: string; ok: boolean; error?: string } | null>(null)
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

  const api = window.electron
  const toast = useToast()

  const refreshHealth = useCallback(async () => {
    setHealthLoading(true)
    try {
      setHealth(await api.setup.getHealth())
    } finally {
      setHealthLoading(false)
    }
  }, [api])

  useEffect(() => {
    api.config.get().then(setConfig)
    api.config.getMcpStatus().then(setStatus)
    refreshHealth()
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
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
      const [newStatus] = await Promise.all([api.config.getMcpStatus(), refreshHealth()])
      setStatus(newStatus)
      toast.success('Settings saved')
    } catch (err: any) {
      toast.error('Failed to save settings', { message: err?.message })
    } finally {
      setSaving(false)
    }
  }

  const handleAddServer = async (srv: McpServerConfig) => {
    if (saving) return
    setSaving(true)
    try {
      const updated = { ...config, mcp_servers: [...config.mcp_servers, srv] }
      setConfig(updated)
      setShowNewServer(false)
      await api.config.update(updated)
      await refreshHealth()
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
      setSaving(false)
    }
  }

  const handleRemoveServer = async (name: string) => {
    try {
      const updated = { ...config, mcp_servers: config.mcp_servers.filter((s) => s.name !== name) }
      setConfig(updated)
      await api.config.update(updated)
      await refreshHealth()
      toast.success(`Server "${name}" removed`)
    } catch (err: any) {
      toast.error('Failed to remove server', { message: err?.message })
    }
  }

  const handleTestServer = async (srv: McpServerConfig) => {
    setTesting(srv.name)
    try {
      const result = await api.config.testMcpServer(srv)
      setTestResult({ name: srv.name, ok: result.ok, error: result.error })
    } finally {
      setTesting(null)
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
          await refreshHealth()
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
      await refreshHealth()
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

      {/* About You */}
      <div className="card">
        <div className="card__header">
          <div>
            <div className="card__title">About You</div>
            <div className="card__subtitle">Tell mypa who you are so it addresses you directly.</div>
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

        <div className="form-group">
          <label className="form-label">Your name</label>
          <input
            className="form-input"
            type="text"
            placeholder="Your name"
            value={config.owner?.name ?? ''}
            onChange={(e) => setConfig({ ...config, owner: { ...(config.owner ?? {}), name: e.target.value } })}
          />
          <div className="form-hint">How the assistant refers to you in summaries.</div>
        </div>

        {visibleSurfaces.length > 0 ? (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 16px' }}>
              {visibleSurfaces.map((surface) => {
                const surfaceStatus = handleStatus[surface]
                return (
                  <div key={surface} className="form-group" style={{ marginBottom: 0 }}>
                    <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <span style={{ textTransform: 'capitalize' }}>{surface}</span>
                      {surfaceStatus && (
                        surfaceStatus.needsReview
                          ? <AlertTriangle size={11} color="var(--color-warning, #f59e0b)" title="Confirm — may not match your graph" />
                          : <Check size={11} color="var(--color-success, #22c55e)" title="Auto-filled" />
                      )}
                    </label>
                    <input
                      className="form-input"
                      type="text"
                      placeholder={surface === 'jira' ? 'Display Name' : `handle, handle2`}
                      value={config.owner?.handles?.[surface] ?? ''}
                      onChange={(e) => setConfig({
                        ...config,
                        owner: {
                          ...(config.owner ?? {}),
                          handles: { ...(config.owner?.handles ?? {}), [surface]: e.target.value }
                        }
                      })}
                      style={surfaceStatus?.needsReview ? { borderColor: 'var(--color-warning, #f59e0b)' } : undefined}
                    />
                  </div>
                )
              })}
            </div>
            <div className="form-hint" style={{ marginTop: 10 }}>
              Used to recognise you in your connected surface data. Separate multiple handles with a comma.
            </div>
          </>
        ) : (
          <div className="form-hint">
            Add a GitHub, Slack, Jira, Linear, or Notion MCP server to configure your identity handles.
          </div>
        )}
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
            Powered by your local Claude Code CLI — no API key required.
          </div>
          <label className="form-label">Model</label>
          <select
            className="form-select"
            value={config.claude.model}
            onChange={(e) => setConfig({ ...config, claude: { ...config.claude, model: e.target.value } })}
          >
            <option value="claude-opus-4-8">claude-opus-4-8 (recommended)</option>
            <option value="claude-sonnet-4-6">claude-sonnet-4-6</option>
            <option value="claude-haiku-4-5-20251001">claude-haiku-4-5 (fastest)</option>
          </select>
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

        {testResult && (
          <div className={`alert ${testResult.ok ? 'alert--success' : 'alert--error'}`}>
            {testResult.name}: {testResult.ok ? 'Connected successfully' : `Failed — ${testResult.error}`}
          </div>
        )}

        {config.mcp_servers.length === 0 && !showNewServer && (
          <div style={{ color: 'var(--text-muted)', fontSize: 12, padding: '8px 0' }}>
            No MCP servers configured. Add one to enable tool integrations.
          </div>
        )}

        {config.mcp_servers.map((srv) => {
          const s = status.find((x) => x.name === srv.name)
          const entry = MCP_CATALOG.find((e) => e.id === srv.name)
          const srvHealth = health?.servers.find((h) => h.name === srv.name)
          const needsOAuth = entry?.authType === 'oauth' && (srvHealth?.missingEnvKeys?.length ?? 0) > 0
          const oauthActive = oauthState?.serverName === srv.name
          return (
            <React.Fragment key={srv.name}>
              <div className="mcp-server-row">
                <div
                  className={`mcp-server-row__dot mcp-server-row__dot--${s?.connected ? 'connected' : 'disconnected'}`}
                />
                <div className="mcp-server-row__name">{srv.name}</div>
                <div className="mcp-server-row__count">
                  {s?.connected ? `${s.tools.length} tools` : s ? 'disconnected' : 'unknown'}
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
                  <button
                    className="btn btn--ghost btn--sm"
                    onClick={() => handleTestServer(srv)}
                    disabled={testing === srv.name}
                  >
                    {testing === srv.name ? <span className="spinner" /> : 'Test'}
                  </button>
                  <button className="btn btn--danger btn--sm" onClick={() => handleRemoveServer(srv.name)}>
                    Remove
                  </button>
                </div>
              </div>
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
    </div>
  )
}

// ─── Ambient Autonomy Card ───────────────────────────────────────────────────

const INTENT_TYPES: IntentType[] = ['action', 'suggestion', 'flag', 'digest']
const TIER_LABELS: Record<number, string> = { 0: 'Silent', 1: 'Notify', 2: 'Approve', 3: 'Locked' }
const TIER_HINTS: Record<number, string> = {
  0: 'Acts automatically without telling you',
  1: 'Acts, then tells you what it did',
  2: 'Always asks before doing anything',
  3: 'Never acts — you must initiate'
}

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
      toast.success(`Trust tier updated to "${TIER_LABELS[tier]}"`)
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
          return (
            <div key={type}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontSize: 13, textTransform: 'capitalize' }}>{type}s</span>
                {/* Segmented tier control */}
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
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{TIER_HINTS[currentTier]}</div>
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
        !health.claudeCli,
        ...health.servers.map((s) => s.missingEnvKeys.length > 0 || (s.oauthStaleDays ?? 0) > 60)
      ].filter(Boolean)
    : []

  const allOk = health && health.claudeCli && issues.length === 0

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
          {/* Claude CLI row */}
          <HealthRow
            ok={health.claudeCli}
            label="Claude Code CLI"
            detail={health.claudeCli ? 'Detected' : 'Not found'}
            action={
              !health.claudeCli ? (
                <a
                  href="#"
                  onClick={(e) => { e.preventDefault(); window.open('https://claude.ai/download') }}
                  style={{ fontSize: 11, color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: 3 }}
                >
                  Install →
                </a>
              ) : null
            }
          />

          {/* Per-server rows */}
          {health.servers.map((srv) => {
            const isStale = (srv.oauthStaleDays ?? 0) > 60
            const hasMissing = srv.missingEnvKeys.length > 0
            const ok = !hasMissing && !isStale

            let detail = 'Connected'
            if (hasMissing) detail = `Missing: ${srv.missingEnvKeys.join(', ')}`
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
