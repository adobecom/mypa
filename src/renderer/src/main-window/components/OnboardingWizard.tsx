import React, { useState, useEffect, useCallback } from 'react'
import { Check, RefreshCw, Wand2, AlertTriangle, KeyRound } from 'lucide-react'
import LogoMark from '../../LogoMark'
import ServerCatalogPicker from './ServerCatalogPicker'
import { useToast } from '../toast/ToastProvider'
import type { AppConfig, McpServerConfig, OAuthAppCredential, OAuthProvider, ResolvedOwnerHandles, AuthSource } from '@shared/types'

interface Props {
  onComplete: () => void
}

type Step = 1 | 2 | 3 | 4 | 5

export default function OnboardingWizard({ onComplete }: Props): React.ReactElement {
  const [step, setStep] = useState<Step>(1)
  const [authState, setAuthState] = useState<{ ok: boolean; source: AuthSource } | null>(null)
  const [checkingAuth, setCheckingAuth] = useState(false)
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [savingKey, setSavingKey] = useState(false)
  const [existingServers, setExistingServers] = useState<McpServerConfig[]>([])
  const [serversAdded, setServersAdded] = useState<McpServerConfig[]>([])
  const [oauthCreds, setOauthCreds] = useState<AppConfig['oauth_apps']>({})
  const [transitioning, setTransitioning] = useState(false)
  const [ownerName, setOwnerName] = useState('')
  const [ownerHandles, setOwnerHandles] = useState<NonNullable<AppConfig['owner']>['handles']>({})
  const [autoFilling, setAutoFilling] = useState(false)
  const [handleStatus, setHandleStatus] = useState<ResolvedOwnerHandles>({})

  const api = window.electron
  const toast = useToast()

  useEffect(() => {
    api.config.get()
      .then((cfg) => {
        setExistingServers(cfg.mcp_servers)
        setOauthCreds(cfg.oauth_apps ?? {})
        setOwnerName(cfg.owner?.name ?? '')
        setOwnerHandles(cfg.owner?.handles ?? {})
      })
      .catch(() => toast.error('Could not load config', { message: 'Some settings may not be pre-filled.' }))
  }, [api])

  const checkAuth = useCallback(async () => {
    setCheckingAuth(true)
    try {
      const result = await api.setup.checkPrerequisites()
      setAuthState(result)
    } catch {
      setAuthState({ ok: false, source: 'none' })
      toast.error('Check failed', { message: 'Could not reach the main process. Try restarting mypa.' })
    } finally {
      setCheckingAuth(false)
    }
  }, [api, toast])

  useEffect(() => {
    if (step === 2 && authState === null) checkAuth()
  }, [step, authState, checkAuth])

  const handleNext = async () => {
    if (transitioning) return
    setTransitioning(true)
    try {
      if (step === 4) {
        await api.config.update({
          owner: {
            name: ownerName.trim() || undefined,
            handles: ownerHandles
          }
        })
      }
      setStep((s) => (s + 1) as Step)
    } catch {
      toast.error('Could not save your changes', { message: 'Please try again.' })
    } finally {
      setTransitioning(false)
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
        setOwnerHandles((prev) => {
          const merged = { ...prev }
          for (const [surface, entry] of Object.entries(resolved) as [keyof typeof resolved, typeof resolved[keyof typeof resolved]][]) {
            if (entry && !prev?.[surface]) merged[surface] = entry.value
          }
          return merged
        })
      }
    } catch {
      toast.error('Auto-fill failed', { message: 'Could not reach identity tools — fill in your handles manually.' })
    } finally {
      setAutoFilling(false)
    }
  }

  const handleBack = () => { if (!transitioning) setStep((s) => (s - 1) as Step) }

  const handleAddServer = async (srv: McpServerConfig) => {
    const allServers = [...existingServers, ...serversAdded, srv]
    try {
      await api.config.update({ mcp_servers: allServers })
      setServersAdded((prev) => [...prev, srv])
    } catch {
      toast.error('Could not add tool', { message: 'Config could not be saved — try again.' })
    }
  }

  const handleCredentialSave = async (provider: OAuthProvider, creds: OAuthAppCredential) => {
    try {
      await api.config.update({
        oauth_apps: { [provider]: creds } as AppConfig['oauth_apps'],
        oauth_connected_at: { [provider]: new Date().toISOString() } as AppConfig['oauth_connected_at']
      })
      setOauthCreds((prev) => ({ ...prev, [provider]: creds }))
    } catch {
      toast.error('Could not save credentials', { message: 'Config could not be saved — try again.' })
    }
  }

  const handleFinish = async () => {
    if (transitioning) return
    setTransitioning(true)
    try {
      await api.config.update({ onboarding_complete: true })
      onComplete()
    } catch {
      toast.error('Could not finish setup', { message: 'Please try again.' })
    } finally {
      setTransitioning(false)
    }
  }

  const handleSaveApiKey = async () => {
    if (!apiKeyInput.trim()) return
    setSavingKey(true)
    try {
      await api.config.setClaudeKey(apiKeyInput.trim())
      setApiKeyInput('')
      await checkAuth()
    } catch {
      toast.error('Could not save API key', { message: 'Please try again.' })
    } finally {
      setSavingKey(false)
    }
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'flex-start',
      minHeight: '100vh',
      padding: '48px 24px 32px',
      background: 'var(--bg-base)'
    }}>
      {/* Progress dots */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 40 }}>
        {([1, 2, 3, 4, 5] as Step[]).map((s) => (
          <div
            key={s}
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: s <= step ? 'var(--accent)' : 'var(--border-subtle, rgba(255,255,255,0.15))',
              transition: 'background 0.2s'
            }}
          />
        ))}
      </div>

      <div style={{ width: '100%', maxWidth: 520 }}>

        {/* ── Step 1: Welcome ─────────────────────────────────────────────── */}
        {step === 1 && (
          <div style={{ textAlign: 'center' }}>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}>
              <LogoMark size={52} />
            </div>
            <div style={{ fontSize: 28, fontWeight: 700, marginBottom: 10 }}>Welcome to mypa</div>
            <div style={{ fontSize: 15, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 36 }}>
              Run routines and handle tasks using Claude AI and the tools you connect.
              Let's get you set up in just a few steps.
            </div>
            <button className="btn btn--primary" style={{ fontSize: 15, padding: '10px 28px' }} onClick={handleNext} disabled={transitioning}>
              Get started →
            </button>
          </div>
        )}

        {/* ── Step 2: Connect Claude ───────────────────────────────────────── */}
        {step === 2 && (
          <div>
            <div style={{ marginBottom: 28 }}>
              <div style={{ fontSize: 22, fontWeight: 700, marginBottom: 6 }}>Connect Claude</div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                mypa needs access to the Claude AI API. Provide an API key or use your existing Claude login.
              </div>
            </div>

            <div className="card" style={{ padding: '16px 20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                {checkingAuth ? (
                  <span className="spinner" />
                ) : authState?.ok ? (
                  <div style={{
                    width: 22, height: 22, borderRadius: '50%',
                    background: 'var(--color-success, #22c55e)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0
                  }}>
                    <Check size={13} color="white" strokeWidth={3} />
                  </div>
                ) : authState && !authState.ok ? (
                  <div style={{
                    width: 22, height: 22, borderRadius: '50%',
                    background: 'var(--color-error, #ef4444)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                    fontSize: 13, color: 'white', fontWeight: 700
                  }}>✕</div>
                ) : null}
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>Claude authentication</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 1 }}>
                    {checkingAuth
                      ? 'Checking…'
                      : authState?.ok
                        ? authState.source === 'apikey'
                          ? 'API key configured'
                          : authState.source === 'env'
                            ? 'Using environment credentials'
                            : 'Claude login detected'
                        : 'No credentials detected'}
                  </div>
                </div>
                {!checkingAuth && (
                  <button
                    className="btn btn--ghost btn--sm"
                    onClick={checkAuth}
                    style={{ display: 'flex', alignItems: 'center', gap: 4 }}
                  >
                    <RefreshCw size={12} />
                    Retry
                  </button>
                )}
              </div>

              {authState && !authState.ok && (
                <div style={{
                  marginTop: 16, padding: '12px 14px',
                  background: 'var(--bg-elevated)', borderRadius: 'var(--radius-md)'
                }}>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10 }}>
                    Enter an Anthropic API key to authenticate:
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      type="password"
                      placeholder="sk-ant-…"
                      value={apiKeyInput}
                      onChange={(e) => setApiKeyInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleSaveApiKey() }}
                      style={{
                        flex: 1, fontFamily: 'monospace', fontSize: 13,
                        padding: '7px 10px', borderRadius: 'var(--radius-sm)',
                        border: '1px solid var(--border)', background: 'var(--bg-base)',
                        color: 'var(--text-primary)', outline: 'none'
                      }}
                    />
                    <button
                      className="btn btn--primary btn--sm"
                      onClick={handleSaveApiKey}
                      disabled={!apiKeyInput.trim() || savingKey}
                      style={{ display: 'flex', alignItems: 'center', gap: 4 }}
                    >
                      {savingKey ? <span className="spinner" /> : <KeyRound size={13} />}
                      Save
                    </button>
                  </div>
                  <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>
                    Get a key at{' '}
                    <a
                      href="#"
                      onClick={(e) => { e.preventDefault(); window.open('https://console.anthropic.com/settings/keys') }}
                      style={{ color: 'var(--accent)' }}
                    >
                      console.anthropic.com
                    </a>
                    . Already logged in with Claude? Hit Retry — your session will be detected.
                  </div>
                </div>
              )}
            </div>

            <WizardNav
              onBack={handleBack}
              onNext={handleNext}
              nextDisabled={(!!apiKeyInput.trim() && !authState?.ok) || transitioning}
              backDisabled={transitioning}
              nextLabel="Next →"
            />
          </div>
        )}

        {/* ── Step 3: Connect Tools ────────────────────────────────────────── */}
        {step === 3 && (
          <div>
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 22, fontWeight: 700, marginBottom: 6 }}>Connect your tools</div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                Add integrations like GitHub, Jira, or Slack. You can always add more in Settings.
              </div>
            </div>

            {serversAdded.length > 0 && (
              <div style={{ marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {serversAdded.map((srv) => (
                  <div key={srv.name} style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '6px 10px', background: 'var(--bg-elevated)',
                    borderRadius: 'var(--radius-sm)', fontSize: 13
                  }}>
                    <Check size={13} color="var(--color-success, #22c55e)" />
                    <span>{srv.name} added</span>
                  </div>
                ))}
              </div>
            )}

            <div className="card" style={{ padding: 16 }}>
              <ServerCatalogPicker
                onAdd={handleAddServer}
                onCancel={() => setStep(5)}
                oauthCreds={oauthCreds}
                onCredentialSave={handleCredentialSave}
                existingNames={[...existingServers, ...serversAdded].map((s) => s.name)}
              />
            </div>

            <div style={{ marginTop: 20, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <button className="btn btn--ghost btn--sm" onClick={handleBack} disabled={transitioning}>← Back</button>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <button
                  className="btn btn--ghost btn--sm"
                  style={{ color: 'var(--text-muted)', fontSize: 12 }}
                  onClick={() => { if (!transitioning) setStep(4) }}
                  disabled={transitioning}
                >
                  Skip for now
                </button>
                {serversAdded.length > 0 && (
                  <button className="btn btn--primary btn--sm" onClick={() => { if (!transitioning) setStep(4) }} disabled={transitioning}>
                    Done adding tools →
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── Step 4: About You ────────────────────────────────────────────── */}
        {step === 4 && (
          <div>
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 22, fontWeight: 700, marginBottom: 6 }}>About you</div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                Tell mypa who you are so it addresses you directly instead of by your handle.
              </div>
            </div>

            <div className="card" style={{ padding: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  Optional — you can fill this in later via Settings.
                </span>
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
              </div>

              <div className="form-group">
                <label className="form-label">Your name</label>
                <input
                  className="form-input"
                  type="text"
                  placeholder="Your name"
                  value={ownerName}
                  onChange={(e) => setOwnerName(e.target.value)}
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 16px' }}>
                {(['github', 'slack', 'jira', 'linear', 'notion'] as const).map((surface) => {
                  const status = handleStatus[surface]
                  return (
                    <div key={surface} className="form-group" style={{ marginBottom: 0 }}>
                      <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        <span style={{ textTransform: 'capitalize' }}>{surface}</span>
                        {status && (
                          status.needsReview
                            ? <AlertTriangle size={11} color="var(--color-warning, #f59e0b)" title="Confirm — may not match your graph" />
                            : <Check size={11} color="var(--color-success, #22c55e)" title="Auto-filled" />
                        )}
                      </label>
                      <input
                        className="form-input"
                        type="text"
                        placeholder={surface === 'jira' ? 'Display Name' : `handle, handle2`}
                        value={ownerHandles?.[surface] ?? ''}
                        onChange={(e) => setOwnerHandles((prev) => ({ ...(prev ?? {}), [surface]: e.target.value }))}
                        style={status?.needsReview ? { borderColor: 'var(--color-warning, #f59e0b)' } : undefined}
                      />
                    </div>
                  )
                })}
              </div>
            </div>

            <WizardNav
              onBack={handleBack}
              onNext={handleNext}
              nextDisabled={transitioning}
              backDisabled={transitioning}
              nextLabel={transitioning ? 'Saving…' : 'Next →'}
              nextSpinner={transitioning}
            />
          </div>
        )}

        {/* ── Step 5: All Set ──────────────────────────────────────────────── */}
        {step === 5 && (
          <div>
            <div style={{ textAlign: 'center', marginBottom: 32 }}>
              <div style={{
                width: 56, height: 56, borderRadius: '50%',
                background: 'var(--color-success, #22c55e)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                margin: '0 auto 16px'
              }}>
                <Check size={26} color="white" strokeWidth={2.5} />
              </div>
              <div style={{ fontSize: 22, fontWeight: 700, marginBottom: 6 }}>You're all set</div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                mypa is ready. Here's what was configured:
              </div>
            </div>

            <div className="card" style={{ padding: '14px 18px', marginBottom: 24 }}>
              <SummaryRow ok={authState?.ok ?? false} label={authState?.ok ? 'Claude authenticated' : 'Claude not authenticated — add a key in Settings'} />
              <SummaryRow ok label="Model selection: automatic" />
              {serversAdded.length > 0 ? (
                <SummaryRow ok label={`${serversAdded.length} tool${serversAdded.length === 1 ? '' : 's'} connected`} />
              ) : (
                <SummaryRow ok={false} label="No tools yet — add them in Settings anytime" />
              )}
              {ownerName.trim() ? (
                <SummaryRow ok label={`Personalized for ${ownerName.trim()}`} />
              ) : (
                <SummaryRow ok={false} label="Identity not set — add it in Settings anytime" />
              )}
            </div>

            <div style={{ textAlign: 'center' }}>
              <button
                className="btn btn--primary"
                style={{ fontSize: 15, padding: '10px 28px', display: 'inline-flex', alignItems: 'center', gap: 8 }}
                onClick={handleFinish}
                disabled={transitioning}
              >
                {transitioning && <span className="spinner" />}
                {transitioning ? 'Saving…' : 'Start using mypa'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function WizardNav({
  onBack,
  onNext,
  nextLabel = 'Next →',
  nextDisabled = false,
  backDisabled = false,
  nextSpinner = false
}: {
  onBack: () => void
  onNext: () => void
  nextLabel?: string
  nextDisabled?: boolean
  backDisabled?: boolean
  nextSpinner?: boolean
}): React.ReactElement {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 28 }}>
      <button className="btn btn--ghost btn--sm" onClick={onBack} disabled={backDisabled}>← Back</button>
      <button
        className="btn btn--primary"
        onClick={onNext}
        disabled={nextDisabled}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
      >
        {nextSpinner && <span className="spinner" />}
        {nextLabel}
      </button>
    </div>
  )
}

function SummaryRow({ ok, label }: { ok: boolean; label: string }): React.ReactElement {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0' }}>
      {ok ? (
        <Check size={14} color="var(--color-success, #22c55e)" strokeWidth={2.5} />
      ) : (
        <div style={{ width: 14, height: 14, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--text-muted)' }} />
        </div>
      )}
      <span style={{ fontSize: 13, color: ok ? 'var(--text-primary)' : 'var(--text-muted)' }}>{label}</span>
    </div>
  )
}
