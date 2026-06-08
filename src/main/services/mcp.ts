import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { readConfig, updateConfig } from './config'
import type { McpServerConfig, McpTool, McpServerStatus, ResolvedOwnerHandles } from '@shared/types'

interface ActiveServer {
  client: Client
  transport: StdioClientTransport
  tools: McpTool[]
  config: McpServerConfig
}

const servers = new Map<string, ActiveServer>()

export async function connectServer(cfg: McpServerConfig): Promise<McpTool[]> {
  await disconnectServer(cfg.name)

  const mergedEnv = { ...process.env, ...(cfg.env ?? {}) } as Record<string, string>
  // Backward compat: server-github reads GITHUB_PERSONAL_ACCESS_TOKEN, not GITHUB_TOKEN
  if (mergedEnv.GITHUB_TOKEN && !mergedEnv.GITHUB_PERSONAL_ACCESS_TOKEN) {
    mergedEnv.GITHUB_PERSONAL_ACCESS_TOKEN = mergedEnv.GITHUB_TOKEN
  }
  const transport = new StdioClientTransport({
    command: cfg.command,
    args: cfg.args ?? [],
    env: mergedEnv
  })

  const client = new Client(
    { name: 'mypa', version: '0.1.0' },
    { capabilities: {} }
  )

  await client.connect(transport)

  const toolsResult = await client.listTools()
  const tools: McpTool[] = (toolsResult.tools ?? []).map((t) => ({
    name: t.name,
    description: t.description ?? '',
    inputSchema: (t.inputSchema as Record<string, unknown>) ?? {}
  }))

  servers.set(cfg.name, { client, transport, tools, config: cfg })
  return tools
}

export async function disconnectServer(name: string): Promise<void> {
  const server = servers.get(name)
  if (!server) return
  try {
    await server.client.close()
  } catch {}
  servers.delete(name)
}

export async function callTool(
  serverName: string,
  toolName: string,
  params: Record<string, unknown>
): Promise<string> {
  const server = servers.get(serverName)
  if (!server) throw new Error(`MCP server "${serverName}" not connected`)

  const result = await server.client.callTool({ name: toolName, arguments: params })
  const content = result.content ?? []
  return content
    .map((c: any) => (c.type === 'text' ? c.text : JSON.stringify(c)))
    .join('\n')
}

export async function connectAllServers(): Promise<void> {
  let cfg = readConfig()

  // Migrate GITHUB_TOKEN → GITHUB_PERSONAL_ACCESS_TOKEN in stored config
  const needsMigration = cfg.mcp_servers.some(
    (s) => s.name === 'github' && s.env?.GITHUB_TOKEN && !s.env?.GITHUB_PERSONAL_ACCESS_TOKEN
  )
  if (needsMigration) {
    updateConfig({
      mcp_servers: cfg.mcp_servers.map((s) => {
        if (s.name !== 'github' || !s.env?.GITHUB_TOKEN) return s
        const { GITHUB_TOKEN, ...rest } = s.env
        return { ...s, env: { ...rest, GITHUB_PERSONAL_ACCESS_TOKEN: GITHUB_TOKEN } }
      })
    })
    cfg = readConfig()
    console.log('[mcp] migrated github: GITHUB_TOKEN → GITHUB_PERSONAL_ACCESS_TOKEN')
  }

  for (const srv of cfg.mcp_servers) {
    try {
      await connectServer(srv)
      console.log(`[mcp] connected: ${srv.name}`)
    } catch (err) {
      console.error(`[mcp] failed to connect ${srv.name}:`, err)
    }
  }
}

export async function disconnectAllServers(): Promise<void> {
  for (const name of [...servers.keys()]) {
    await disconnectServer(name)
  }
}

export function getServerStatus(): McpServerStatus[] {
  const cfg = readConfig()
  return cfg.mcp_servers.map((srv) => {
    const active = servers.get(srv.name)
    return {
      name: srv.name,
      connected: !!active,
      tools: active?.tools ?? []
    }
  })
}

// ─── Owner identity resolution ────────────────────────────────────────────────

const SURFACE_NAMES = ['github', 'slack', 'jira', 'linear', 'notion'] as const
type SurfaceName = typeof SURFACE_NAMES[number]

/** Tool names that are likely to return the authenticated user's identity */
const IDENTITY_TOOL_PATTERN = /whoami|get_me|^me$|current_user|viewer|self|auth.?test|read_user_profile/i

/**
 * Returns true for opaque / non-human-readable IDs (Slack UIDs like U07ABC,
 * UUIDs, bare numbers) that won't match what is stored in the graph as a node label.
 */
function isOpaqueId(value: string): boolean {
  return /^[UW][A-Z0-9]{6,}$/.test(value) ||   // Slack UID
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) || // UUID
    /^\d+$/.test(value)                           // bare numeric id
}

/** Try to extract a human-readable identity handle from the raw string returned by callTool */
function extractHandle(raw: string): string | null {
  let obj: Record<string, unknown> | null = null
  try {
    obj = JSON.parse(raw)
  } catch {
    // Not JSON — try to pull a quoted value for common identity keys
    const match = raw.match(/"(?:login|username|name|display_name|displayName|accountId|id)"\s*:\s*"([^"]+)"/)
    return match ? match[1] : null
  }
  if (!obj || typeof obj !== 'object') return null

  const KEYS = ['login', 'username', 'name', 'display_name', 'displayName', 'accountId', 'id']
  // Walk one level of nesting: top-level, obj.user, obj.viewer, obj.data.viewer
  const candidates: unknown[] = [obj, (obj as any).user, (obj as any).viewer, (obj as any)?.data?.viewer]
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue
    for (const key of KEYS) {
      const val = (candidate as Record<string, unknown>)[key]
      if (typeof val === 'string' && val.trim()) return val.trim()
    }
  }
  return null
}

/**
 * Best-effort: calls each connected MCP server's identity tool (if one exists)
 * and returns a pre-filled handle with a `needsReview` flag where the resolved
 * value is opaque (e.g. a Slack UID that won't match a graph node label).
 */
export async function resolveOwnerHandles(): Promise<ResolvedOwnerHandles> {
  const result: ResolvedOwnerHandles = {}
  const connected = getServerStatus().filter((s) => s.connected)

  for (const server of connected) {
    const surfaceName = SURFACE_NAMES.find((n) => server.name === n)
    if (!surfaceName) continue

    const identityTool = server.tools.find((t) => IDENTITY_TOOL_PATTERN.test(t.name))
    if (!identityTool) continue

    try {
      const raw = await callTool(server.name, identityTool.name, {})
      const handle = extractHandle(raw)
      if (handle) {
        result[surfaceName] = { value: handle, needsReview: isOpaqueId(handle) }
      }
    } catch (err) {
      console.warn(`[mcp] resolveOwnerHandles: ${server.name} failed:`, err)
    }
  }

  return result
}

export async function testServer(
  cfg: McpServerConfig
): Promise<{ ok: boolean; tools: McpTool[]; error?: string }> {
  let client: Client | null = null
  let transport: StdioClientTransport | null = null
  try {
    transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args ?? [],
      env: { ...process.env, ...(cfg.env ?? {}) } as Record<string, string>
    })
    client = new Client({ name: 'mypa-test', version: '0.1.0' }, { capabilities: {} })
    await client.connect(transport)
    const toolsResult = await client.listTools()
    const tools: McpTool[] = (toolsResult.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? {}
    }))
    return { ok: true, tools }
  } catch (err: any) {
    return { ok: false, tools: [], error: err?.message ?? String(err) }
  } finally {
    try { await client?.close() } catch {}
  }
}
