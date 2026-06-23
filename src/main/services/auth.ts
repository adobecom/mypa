import { existsSync } from 'fs'
import { join } from 'path'
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
 *   4. None detected
 *
 * NOTE: On macOS a Keychain-stored Claude Code login token is NOT readable by
 * this file-based probe — resolveAuthSource() may return { ok: false, source: 'none' }
 * even when valid Keychain credentials exist. The onboarding wizard treats this as
 * a soft warning (not a hard block) so Keychain-auth users are not stranded.
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

  return { ok: false, source: 'none' }
}
