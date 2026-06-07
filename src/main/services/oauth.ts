import { shell } from 'electron'
import { createHash, randomBytes } from 'crypto'
import { readConfig } from './config'
import type { OAuthProvider } from '@shared/types'

// Resolves the pending PKCE code exchange when the OS delivers the callback URL
let pendingPkceResolve: ((code: string) => void) | null = null
let pendingPkceReject: ((err: Error) => void) | null = null
let pendingState: string | null = null

export function handleOAuthCallback(url: string): void {
  try {
    const parsed = new URL(url)
    const code = parsed.searchParams.get('code')
    const error = parsed.searchParams.get('error')
    const returnedState = parsed.searchParams.get('state')
    if (error) {
      pendingPkceReject?.(new Error(`OAuth denied: ${error}`))
    } else if (code && returnedState === pendingState) {
      pendingPkceResolve?.(code)
    } else if (code) {
      // state mismatch — reject to prevent authorization code injection via custom URI scheme
      pendingPkceReject?.(new Error('OAuth state mismatch — request may have been tampered with'))
    }
  } catch {
    // malformed URL — ignore
  } finally {
    pendingPkceResolve = null
    pendingPkceReject = null
    pendingState = null
  }
}

// ─── GitHub Device Flow ───────────────────────────────────────────────────────

export interface DeviceFlowStart {
  userCode: string
  verificationUri: string
  deviceCode: string
  interval: number
}

export async function startDeviceFlow(): Promise<DeviceFlowStart> {
  const clientId = readConfig().oauth_apps?.github?.clientId ?? ''
  if (!clientId) throw new Error('GitHub OAuth app not configured — add your Client ID in Settings.')

  const res = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: clientId, scope: 'repo read:user' })
  })
  if (!res.ok) throw new Error(`GitHub device code request failed: ${res.status}`)
  const data = (await res.json()) as {
    device_code: string
    user_code: string
    verification_uri: string
    interval: number
  }
  shell.openExternal(data.verification_uri)
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    interval: data.interval ?? 5
  }
}

export async function pollDeviceFlow(deviceCode: string): Promise<string> {
  const clientId = readConfig().oauth_apps?.github?.clientId ?? ''
  const maxAttempts = 120  // up to 10 min at 5s intervals
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(5000)
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
      })
    })
    const data = (await res.json()) as Record<string, string>
    if (data.access_token) return data.access_token
    if (data.error === 'access_denied') throw new Error('Access denied')
    if (data.error === 'expired_token') throw new Error('Code expired — please try again')
    // 'authorization_pending' or 'slow_down' → keep polling
  }
  throw new Error('Authorization timed out')
}

// ─── PKCE / Redirect Flow (Notion, Linear) ───────────────────────────────────

const REDIRECT_URI = 'mypa://oauth/callback'

function buildAuthUrl(
  provider: 'notion' | 'linear',
  clientId: string,
  codeChallenge: string,
  state: string
): string {
  const base = encodeURIComponent(REDIRECT_URI)
  if (provider === 'notion') {
    // Notion does not support PKCE — use state to prevent authorization code injection via mypa:// URI scheme
    return `https://api.notion.com/v1/oauth/authorize?client_id=${clientId}&response_type=code&owner=user&redirect_uri=${base}&state=${state}`
  }
  // Linear supports PKCE; state adds defense-in-depth
  return (
    `https://linear.app/oauth/authorize` +
    `?client_id=${clientId}` +
    `&redirect_uri=${base}` +
    `&response_type=code` +
    `&scope=read,write` +
    `&code_challenge=${codeChallenge}` +
    `&code_challenge_method=S256` +
    `&state=${state}`
  )
}

export async function startPkceFlow(provider: 'notion' | 'linear'): Promise<string> {
  const creds = readConfig().oauth_apps?.[provider]
  const clientId = creds?.clientId ?? ''
  if (!clientId) {
    const name = provider.charAt(0).toUpperCase() + provider.slice(1)
    throw new Error(`${name} OAuth app not configured — add your credentials in Settings.`)
  }

  const codeVerifier = randomBytes(32).toString('base64url')
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
  const state = randomBytes(16).toString('hex')

  const authUrl = buildAuthUrl(provider, clientId, codeChallenge, state)
  shell.openExternal(authUrl)

  const code = await new Promise<string>((resolve, reject) => {
    pendingPkceResolve = resolve
    pendingPkceReject = reject
    pendingState = state
    setTimeout(() => {
      pendingPkceResolve = null
      pendingPkceReject = null
      pendingState = null
      reject(new Error('OAuth timed out — no response received'))
    }, 5 * 60 * 1000)
  })

  return exchangeCode(provider, clientId, creds?.clientSecret, code, codeVerifier)
}

async function exchangeCode(
  provider: 'notion' | 'linear',
  clientId: string,
  clientSecret: string | undefined,
  code: string,
  codeVerifier: string
): Promise<string> {
  if (provider === 'notion') {
    const credentials = Buffer.from(`${clientId}:${clientSecret ?? ''}`).toString('base64')
    const res = await fetch('https://api.notion.com/v1/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${credentials}`
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI
      })
    })
    const data = (await res.json()) as Record<string, string>
    if (!data.access_token) throw new Error(data.error_description ?? 'Token exchange failed')
    return data.access_token
  }

  // Linear
  const params = new URLSearchParams({
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    client_secret: clientSecret ?? '',
    code_verifier: codeVerifier,
    grant_type: 'authorization_code'
  })
  const res = await fetch('https://api.linear.app/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  })
  const data = (await res.json()) as Record<string, string>
  if (!data.access_token) throw new Error(data.error_description ?? 'Token exchange failed')
  return data.access_token
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
