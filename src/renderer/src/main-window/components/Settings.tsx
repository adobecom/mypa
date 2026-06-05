import React, { useState, useEffect } from 'react'
import type { AppConfig, McpServerConfig, McpServerStatus } from '@shared/types'
import ServerCatalogPicker from './ServerCatalogPicker'

export default function Settings(): React.ReactElement {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [status, setStatus] = useState<McpServerStatus[]>([])
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [showNewServer, setShowNewServer] = useState(false)
  const [testing, setTesting] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<{ name: string; ok: boolean; error?: string } | null>(null)

  const api = window.electron

  useEffect(() => {
    api.config.get().then(setConfig)
    api.config.getMcpStatus().then(setStatus)
  }, [])

  if (!config) return <div style={{ padding: 24, color: 'var(--text-muted)' }}>Loading…</div>

  const handleSave = async () => {
    setSaving(true)
    try {
      await api.config.update(config)
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
      setStatus(await api.config.getMcpStatus())
    } finally {
      setSaving(false)
    }
  }

  const handleAddServer = (srv: McpServerConfig) => {
    setConfig({ ...config, mcp_servers: [...config.mcp_servers, srv] })
    setShowNewServer(false)
  }

  const handleRemoveServer = (name: string) => {
    setConfig({ ...config, mcp_servers: config.mcp_servers.filter((s) => s.name !== name) })
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

  return (
    <div>
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div className="page-title">Settings</div>
            <div className="page-subtitle">Configure Claude and MCP integrations</div>
          </div>
          <button className="btn btn--primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : saved ? 'Saved' : 'Save changes'}
          </button>
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
          return (
            <div key={srv.name} className="mcp-server-row">
              <div
                className={`mcp-server-row__dot mcp-server-row__dot--${s?.connected ? 'connected' : 'disconnected'}`}
              />
              <div className="mcp-server-row__name">{srv.name}</div>
              <div className="mcp-server-row__count">
                {s?.connected ? `${s.tools.length} tools` : s ? 'disconnected' : 'unknown'}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
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
          )
        })}

        {showNewServer && (
          <ServerCatalogPicker onAdd={handleAddServer} onCancel={() => setShowNewServer(false)} />
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
    </div>
  )
}

