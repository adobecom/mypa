import { join } from 'path'
import { homedir } from 'os'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import type { AppConfig } from '@shared/types'
import { DEFAULT_CONFIG } from '@shared/types'

const CONFIG_DIR = join(homedir(), '.mypa')
const CONFIG_PATH = join(CONFIG_DIR, 'config.json')

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
    return deepMerge(DEFAULT_CONFIG, parsed) as AppConfig
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function writeConfig(config: AppConfig): void {
  ensureConfigDir()
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
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
