import { existsSync } from 'fs'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { readConfig } from './config'

export type AuthSource = 'apikey' | 'env' | 'cli-login' | 'none'

/**
 * Returns the env override to pass as `options.env` in agent.ts query() calls.
 *
 * When the user has configured an Anthropic API key in mypa, it is injected as
 * ANTHROPIC_API_KEY so the SDK uses it instead of ambient credentials.
 *
 * IMPORTANT: the SDK `options.env` REPLACES the subprocess environment entirely
 * (it is NOT merged with process.env). Always spread process.env first so PATH,
 * HOME, and other critical variables are preserved.
 *
 * Returns `undefined` when no key is stored — the SDK then inherits process.env
 * unchanged and picks up any ambient credentials (ANTHROPIC_API_KEY env var,
 * CLAUDE_CODE_OAUTH_TOKEN env var, or a ~/.claude login session).
 */
export function buildAgentEnv(): Record<string, string | undefined> | undefined {
  const key = readConfig().claude?.apiKey
  if (!key) return undefined
  return { ...process.env, ANTHROPIC_API_KEY: key }
}

/**
 * Detect which auth source is active, in priority order:
 *   1. Stored API key in config (highest — user explicitly provided it)
 *   2. ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN env var (process-inherited)
 *   3. ~/.claude/.credentials.json presence (Claude Code login session)
 *   4. macOS Keychain "Claude Code-credentials" entry (Claude Code login session)
 *   5. None detected
 *
 * NOTE: `claude login` on macOS stores its session in the Keychain rather than
 * ~/.claude/.credentials.json, so step 3 alone misses it — step 4 covers that case.
 * The Agent SDK subprocess runs as the same OS user, so it can read the same
 * Keychain entry at call time, making this detection accurate.
 */
export function resolveAuthSource(): { ok: boolean; source: AuthSource } {
  // 1. Stored API key
  const key = readConfig().claude?.apiKey
  if (key?.trim()) return { ok: true, source: 'apikey' }

  // 2. Inherited env vars
  if (process.env.ANTHROPIC_API_KEY?.trim() || process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) {
    return { ok: true, source: 'env' }
  }

  // 3. ~/.claude/.credentials.json (written by `claude login`)
  const home = process.env.HOME || ''
  if (home && existsSync(join(home, '.claude', '.credentials.json'))) {
    return { ok: true, source: 'cli-login' }
  }

  // 4. macOS Keychain login session (also written by `claude login`)
  if (process.platform === 'darwin' && hasKeychainLogin()) {
    return { ok: true, source: 'cli-login' }
  }

  return { ok: false, source: 'none' }
}

/**
 * Checks for a macOS Keychain entry for the Claude Code CLI login session.
 *
 * Bounded with a timeout: if the item's ACL doesn't already authorize this process,
 * macOS can pop a native "wants to access Keychain item" dialog and `security` blocks
 * waiting for a response. Since this runs synchronously on Electron's single main-process
 * thread (and is called on every onboarding/Settings health check, not just once), an
 * unbounded call could freeze the whole app — IPC, cron, tray — until the dialog is
 * dismissed. `timeout` kills the child and makes this fail closed instead.
 */
function hasKeychainLogin(): boolean {
  try {
    execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials'], {
      stdio: 'ignore',
      timeout: 2000
    })
    return true
  } catch {
    return false
  }
}
