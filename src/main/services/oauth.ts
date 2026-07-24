import { shell } from 'electron'
import { spawn } from 'child_process'
import { createHash, randomBytes } from 'crypto'
import { homedir } from 'os'
import { join } from 'path'
import { readConfig, updateConfig } from './config'
import { broadcast } from '../windows'
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

// ─── Device-code flow (Outlook / Microsoft Graph via ms-365-mcp-server) ──────
//
// Microsoft Graph access tokens are short-lived (~1hr) and mypa's PKCE flow above
// has no refresh-token support, so mypa does not perform the Microsoft handshake
// itself. Instead the MCP server's own `--login` command drives the full MSAL
// device-code flow and caches (and silently refreshes) the token on disk; mypa's
// job is just to surface the device code to the user and wait for login to finish.

const DEVICE_LOGIN_TIMEOUT_MS = 15 * 60 * 1000

// Matches MSAL's device-code prompt, e.g.:
//   "To sign in, use a web browser to open the page https://microsoft.com/devicelogin
//    and enter the code ABCD1234 to authenticate."
const DEVICE_CODE_RE = /open the page (\S+)[\s\S]*?enter the code (\S+)/i

// Login processes currently in flight, tracked only so `killActiveDeviceLogins`
// (called on app quit, mirroring mcp.ts's `disconnectAllServers`) can terminate
// them instead of leaving them orphaned if the user quits mid-login.
const activeLogins = new Set<ReturnType<typeof spawn>>()

/**
 * Spawns a catalog entry's device-code login command, forwards the resulting
 * user code + verification URL to the renderer as they appear in the process's
 * output, and resolves once the login process exits successfully. Records
 * `device_login_at[entryId]` on success for a "Connected on <date>" display —
 * the token itself is never seen by mypa, only by the MCP server.
 */
export function startDeviceLogin(
  entryId: string,
  command: string,
  args: string[],
  env: Record<string, string>
): Promise<void> {
  return new Promise((resolve, reject) => {
    const mergedEnv = { ...process.env, ...env }
    // Same cache path mcp.ts pins for the connected 'outlook' server — sharing one
    // file means a token acquired here is immediately usable once the server connects.
    if (entryId === 'outlook' && !mergedEnv.MS365_MCP_TOKEN_CACHE_PATH) {
      mergedEnv.MS365_MCP_TOKEN_CACHE_PATH = join(homedir(), '.mypa', 'ms365-token-cache.json')
    }
    const child = spawn(command, args, {
      env: mergedEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    activeLogins.add(child)

    let output = ''
    let codeShown = false
    const onData = (chunk: Buffer): void => {
      output += chunk.toString('utf8')
      if (codeShown) return
      const match = DEVICE_CODE_RE.exec(output)
      if (match) {
        codeShown = true
        const [, verificationUri, userCode] = match
        broadcast('oauth:device-code', { entryId, userCode, verificationUri })
        // Mirror the scheme check ipc-handlers.ts applies to the renderer-driven
        // system:open-external channel — this URL comes from parsing subprocess
        // output rather than a URL mypa built itself, so it gets the same guard.
        if (verificationUri.startsWith('https://') || verificationUri.startsWith('http://')) {
          shell.openExternal(verificationUri)
        }
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)

    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('Sign-in timed out — no response received'))
    }, DEVICE_LOGIN_TIMEOUT_MS)

    child.on('error', (err) => {
      clearTimeout(timer)
      activeLogins.delete(child)
      reject(err)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      activeLogins.delete(child)
      if (code === 0) {
        updateConfig({ device_login_at: { [entryId]: new Date().toISOString() } })
        resolve()
      } else {
        reject(new Error(`Sign-in failed (exit code ${code}) — ${output.slice(-500).trim() || 'no output'}`))
      }
    })
  })
}

/** Kills any in-flight device-code login processes. Called during app quit so a
 *  login started but never completed doesn't outlive the main process. */
export function killActiveDeviceLogins(): void {
  for (const child of activeLogins) {
    try { child.kill() } catch { /* already exited */ }
  }
  activeLogins.clear()
}
