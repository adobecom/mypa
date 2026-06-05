import { join } from 'path'
import { homedir } from 'os'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { safeStorage } from 'electron'
import type { AppConfig } from '@shared/types'
import { DEFAULT_CONFIG } from '@shared/types'

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
    return decryptOAuthApps(decryptEnvs(deepMerge(DEFAULT_CONFIG, parsed) as AppConfig))
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function writeConfig(config: AppConfig): void {
  ensureConfigDir()
  writeFileSync(CONFIG_PATH, JSON.stringify(encryptOAuthApps(encryptEnvs(config)), null, 2))
}

export function updateConfig(partial: Partial<AppConfig>): AppConfig {
  const current = readConfig()
  const updated = deepMerge(current, partial) as AppConfig
  writeConfig(updated)
  return updated
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
