import { join } from 'path'
import { homedir } from 'os'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { safeStorage } from 'electron'
import type { AppConfig } from '@shared/types'
import { DEFAULT_CONFIG } from '@shared/types'
import { dbGetActiveHardMemories } from '../db'

const CONFIG_DIR = join(homedir(), '.mypa')
const CONFIG_PATH = join(CONFIG_DIR, 'config.json')
const ENC_PREFIX = 'enc:'

function encryptValue(val: string): string {
  if (val.startsWith(ENC_PREFIX)) return val  // already encrypted — don't double-encrypt
  if (!safeStorage.isEncryptionAvailable()) return val
  return ENC_PREFIX + safeStorage.encryptString(val).toString('base64')
}

function decryptValue(val: string): string {
  if (!val.startsWith(ENC_PREFIX)) return val
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      console.error('[config] safeStorage unavailable — cannot decrypt stored credential')
      return ''
    }
    return safeStorage.decryptString(Buffer.from(val.slice(ENC_PREFIX.length), 'base64'))
  } catch (err) {
    console.error('[config] decryption failed:', err)
    return ''
  }
}

function encryptEnvs(config: AppConfig): AppConfig {
  return {
    ...config,
    mcp_servers: config.mcp_servers.map((srv) => ({
      ...srv,
      env: srv.env
        ? Object.fromEntries(Object.entries(srv.env).map(([k, v]) => [k, encryptValue(v)]))
        : srv.env,
    })),
  }
}

function decryptEnvs(config: AppConfig): AppConfig {
  return {
    ...config,
    mcp_servers: config.mcp_servers.map((srv) => ({
      ...srv,
      env: srv.env
        ? Object.fromEntries(Object.entries(srv.env).map(([k, v]) => [k, decryptValue(v)]))
        : srv.env,
    })),
  }
}

function encryptClaude(config: AppConfig): AppConfig {
  if (!config.claude?.apiKey) return config
  return {
    ...config,
    claude: { ...config.claude, apiKey: encryptValue(config.claude.apiKey) },
  }
}

function decryptClaude(config: AppConfig): AppConfig {
  if (!config.claude?.apiKey) return config
  return {
    ...config,
    claude: { ...config.claude, apiKey: decryptValue(config.claude.apiKey) },
  }
}

function encryptOAuthApps(config: AppConfig): AppConfig {
  if (!config.oauth_apps) return config
  return {
    ...config,
    oauth_apps: Object.fromEntries(
      Object.entries(config.oauth_apps).map(([k, v]) => [
        k,
        v?.clientSecret ? { ...v, clientSecret: encryptValue(v.clientSecret) } : v,
      ])
    ) as AppConfig['oauth_apps'],
  }
}

function decryptOAuthApps(config: AppConfig): AppConfig {
  if (!config.oauth_apps) return config
  return {
    ...config,
    oauth_apps: Object.fromEntries(
      Object.entries(config.oauth_apps).map(([k, v]) => [
        k,
        v?.clientSecret ? { ...v, clientSecret: decryptValue(v.clientSecret) } : v,
      ])
    ) as AppConfig['oauth_apps'],
  }
}

export function ensureConfigDir(): void {
  mkdirSync(CONFIG_DIR, { recursive: true })
}

export function readConfig(): AppConfig {
  ensureConfigDir()
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2))
    return { ...DEFAULT_CONFIG }
  }
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    return decryptClaude(decryptOAuthApps(decryptEnvs(deepMerge(DEFAULT_CONFIG, parsed) as AppConfig)))
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function writeConfig(config: AppConfig): void {
  ensureConfigDir()
  writeFileSync(CONFIG_PATH, JSON.stringify(encryptClaude(encryptOAuthApps(encryptEnvs(config))), null, 2))
}

/** Removes the stored Anthropic API key. Separate from updateConfig because deepMerge skips undefined. */
export function clearClaudeApiKey(): AppConfig {
  const current = readConfig()
  const updated: AppConfig = { ...current, claude: { ...current.claude } }
  delete updated.claude.apiKey
  writeConfig(updated)
  return updated
}

export function updateConfig(partial: Partial<AppConfig>): AppConfig {
  const current = readConfig()
  const updated = deepMerge(current, partial) as AppConfig
  writeConfig(updated)
  return updated
}

// ─── Owner identity helpers ──────────────────────────────────────────────────

/**
 * Returns a flat list of the owner's per-surface handles (non-empty, trimmed).
 * Used by renderPacketForPrompt to tag owner nodes inline.
 */
export function getOwnerHandles(): string[] {
  const handles = readConfig().owner?.handles ?? {}
  return Object.values(handles)
    .filter((h): h is string => typeof h === 'string' && h.trim() !== '')
    .flatMap((h) => h.split(',').map((s) => s.trim()).filter(Boolean))
}

/**
 * Builds a one-sentence owner instruction appended to system prompts so the
 * model addresses the owner as "you" rather than by handle or in the third person.
 * Returns '' when no owner identity is configured.
 */
export function buildOwnerClause(): string {
  const owner = readConfig().owner
  if (!owner?.name && !owner?.handles) return ''

  const name = owner.name?.trim() || 'the user you assist'
  const handles = owner.handles ?? {}
  const handleEntries = Object.entries(handles)
    .flatMap(([surface, v]) => {
      if (typeof v !== 'string' || !v.trim()) return []
      const vals = v.split(',').map((h) => h.trim()).filter(Boolean)
      return vals.length > 0 ? [`${surface}: ${vals.join(', ')}`] : []
    })

  const handlePart = handleEntries.length > 0
    ? ` They appear across connected surfaces under these handles — ${handleEntries.join(', ')}.`
    : ''

  return `\n\nThe person you assist is ${name}.${handlePart} When activity references any of those handles, that is ${name} themselves — address them in the second person ("you"), never in the third person or by their handle.`
}

/**
 * Builds a trusted standing-directives block appended to system prompts so the
 * model treats hard rules (extracted from check-ins) as inviolable instructions,
 * not advisory context. Returns '' when there are no hard memories.
 *
 * Unlike buildOwnerClause(), this is NOT cached — it is re-read at call time so
 * newly-added rules take effect on the very next inference cycle.
 */
export function buildDirectivesClause(): string {
  let rules: string[]
  try {
    rules = dbGetActiveHardMemories().map((m) => m.content)
  } catch {
    return ''
  }
  if (rules.length === 0) return ''

  const bulletList = rules.map((r) => `  - ${r}`).join('\n')
  return `\n\nStanding rules you must always obey (set by the user in past check-ins):\n${bulletList}\nIf a candidate observation or proposed action would violate any of the above, do not surface it — return the "nothing actionable" response instead.`
}

function deepMerge(base: any, override: any): any {
  const result = { ...base }
  for (const key of Object.keys(override ?? {})) {
    if (override[key] !== null && typeof override[key] === 'object' && !Array.isArray(override[key])) {
      result[key] = deepMerge(base[key] ?? {}, override[key])
    } else if (override[key] !== undefined) {
      result[key] = override[key]
    }
  }
  return result
}
