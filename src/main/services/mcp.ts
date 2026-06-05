import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { readConfig, updateConfig } from './config'
import type { McpServerConfig, McpTool, McpServerStatus } from '@shared/types'

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
