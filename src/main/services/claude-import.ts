import { join } from 'path'
import { homedir } from 'os'
import { readFileSync } from 'fs'
import type { DetectedMcpServer } from '@shared/types'

const CLAUDE_JSON_PATH = join(homedir(), '.claude.json')

interface ClaudeMcpEntry {
  command?: string
  args?: string[]
  env?: Record<string, string>
  type?: string
  url?: string
}

/**
 * Reads the global mcpServers from ~/.claude.json.
 * Returns an empty array if the file is missing or unparseable.
 * Only reads the top-level mcpServers (global scope) — per-project entries are ignored.
 */
export function detectClaudeMcpServers(): DetectedMcpServer[] {
  try {
    const raw = readFileSync(CLAUDE_JSON_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    const mcpServers: Record<string, ClaudeMcpEntry> = parsed?.mcpServers ?? {}

    return Object.entries(mcpServers).flatMap(([name, entry]) => {
      if (!entry || typeof entry !== 'object') return []
      const hasCommand = typeof entry.command === 'string' && entry.command.length > 0
      const httpType = entry.type === 'http' || entry.type === 'sse' || (!hasCommand && !!entry.url)
      const type = hasCommand ? 'stdio' : (httpType ? (entry.type ?? 'http') : 'unknown')

      return {
        name,
        command: hasCommand ? entry.command : undefined,
        args: entry.args,
        env: entry.env,
        type,
        url: entry.url,
        // stdio, http, and sse are all supported transports now
        supported: hasCommand || httpType
      }
    })
  } catch {
    return []
  }
}
