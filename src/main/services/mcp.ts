import { homedir } from 'os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { readConfig, updateConfig } from './config'
import type { McpServerConfig, McpTool, McpServerStatus, ResolvedOwnerHandles } from '@shared/types'
import { MCP_CATALOG } from '@shared/mcp-catalog'

interface ActiveServer {
  client: Client
  transport: StdioClientTransport
  tools: McpTool[]
  config: McpServerConfig
}

const servers = new Map<string, ActiveServer>()

// Serialize all connection mutations (connectAllServers, reconnectServer) so that
// two near-simultaneous config:update calls cannot race on the Map and disconnect
// each other's live connections, which would surface as "Connection closed" errors.
let connectQueue: Promise<void> = Promise.resolve()

function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const result = connectQueue.then(fn)
  // Advance the queue regardless of success/failure so it never gets stuck
  connectQueue = result.then(
    () => {},
    () => {}
  )
  return result
}

/** Races `promise` against a timeout. Rejects with a clear message on expiry. */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const race = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
  })
  try {
    return await Promise.race([promise, race])
  } finally {
    clearTimeout(timer!)
  }
}

/**
 * For catalog entries that declare path-type argInputs (e.g. filesystem allowed
 * directories), expand a leading `~` in each positional directory arg so the
 * spawned subprocess receives a real absolute path.
 *
 * The stored config value is intentionally left unexpanded (portable between users),
 * so expansion is done here at connect time rather than at save time.
 */
function expandTildeArgs(cfg: McpServerConfig): string[] {
  const args = cfg.args ?? []
  const entry = MCP_CATALOG.find((e) => e.id === cfg.name)
  if (!entry?.argInputs?.some((a) => a.isPath)) return args

  const baseCount = entry.baseArgs.length
  const dirArgs = args.slice(baseCount).map((raw) => {
    if (raw === '~') return homedir()
    if (raw.startsWith('~/')) return homedir() + raw.slice(1)
    return raw
  })
  return [...args.slice(0, baseCount), ...dirArgs]
}

export async function connectServer(cfg: McpServerConfig): Promise<McpTool[]> {
  await disconnectServer(cfg.name)

  const mergedEnv = { ...process.env, ...(cfg.env ?? {}) } as Record<string, string>
  // Backward compat: server-github reads GITHUB_PERSONAL_ACCESS_TOKEN, not GITHUB_TOKEN
  if (mergedEnv.GITHUB_TOKEN && !mergedEnv.GITHUB_PERSONAL_ACCESS_TOKEN) {
    mergedEnv.GITHUB_PERSONAL_ACCESS_TOKEN = mergedEnv.GITHUB_TOKEN
  }
  const transport = new StdioClientTransport({
    command: cfg.command,
    args: expandTildeArgs(cfg),
    env: mergedEnv,
    stderr: 'pipe'  // pipe instead of inherit so we can re-emit with a prefix and
                    // keep a diagnostic tail for timeout error messages
  })

  const client = new Client(
    { name: 'mypa', version: '0.1.0' },
    { capabilities: {} }
  )

  // Re-emit subprocess stderr line-by-line with a server-name prefix (preserves the
  // visibility that 'inherit' provided) and keep a 30-line ring buffer so that a
  // genuine timeout can report what the server last printed before stalling.
  const stderrLines: string[] = []
  transport.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8')
    for (const line of text.split('\n')) {
      if (line) {
        try { process.stderr.write(`[mcp:${cfg.name}] ${line}\n`) } catch {}
        stderrLines.push(line)
        if (stderrLines.length > 30) stderrLines.shift()
      }
    }
  })

  // Wrap connect + listTools in a try/catch so that if either times out we
  // close the client (which terminates the spawned subprocess) before throwing.
  // Without this the subprocess is orphaned — it never lands in servers.Map so
  // disconnectServer() cannot find and kill it on subsequent reconnect attempts.
  try {
    await withTimeout(client.connect(transport), 30_000, `connect ${cfg.name}`)

    const toolsResult = await withTimeout(client.listTools(), 30_000, `listTools ${cfg.name}`)
    const tools: McpTool[] = (toolsResult.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? {}
    }))

    servers.set(cfg.name, { client, transport, tools, config: cfg })
    // Auto-evict from the Map when the subprocess exits so that subsequent callTool
    // calls don't silently hit a dead client. The guard prevents double-eviction if a
    // concurrent reconnect has already replaced this entry with a fresh one.
    client.onclose = () => {
      if (servers.get(cfg.name)?.client === client) {
        servers.delete(cfg.name)
        console.log(`[mcp:${cfg.name}] disconnected`)
      }
    }
    return tools
  } catch (err) {
    const tail = stderrLines.slice(-5).join('\n').trim()
    const enriched = tail
      ? new Error(`${(err as any)?.message ?? String(err)} — last server output:\n${tail}`)
      : err
    try { await client.close() } catch {}
    throw enriched
  }
}

export async function disconnectServer(name: string): Promise<void> {
  const server = servers.get(name)
  if (!server) return
  try {
    await server.client.close()
  } catch {}
  servers.delete(name)
}

/**
 * Returns the inputSchema for a named tool on a connected server.
 * Used by executeIntent's pre-flight guard to validate assembled args
 * before calling the tool, so missing-arg failures surface with a clear
 * human reason rather than a raw MCP -32603 error.
 */
export function getToolInputSchema(serverName: string, toolName: string): Record<string, unknown> | null {
  const server = servers.get(serverName)
  if (!server) return null
  const tool = server.tools.find((t) => t.name === toolName)
  return tool?.inputSchema ?? null
}

export async function callTool(
  serverName: string,
  toolName: string,
  params: Record<string, unknown>
): Promise<string> {
  const server = servers.get(serverName)
  if (!server) throw new Error(`MCP server "${serverName}" not connected`)

  const result = await withTimeout(
    server.client.callTool({ name: toolName, arguments: params }),
    30_000,
    `callTool ${serverName}::${toolName}`
  )
  const content = result.content ?? []
  return content
    .map((c: any) => (c.type === 'text' ? c.text : JSON.stringify(c)))
    .join('\n')
}

export function connectAllServers(): Promise<void> {
  return runExclusive(async () => {
    let cfg = readConfig()

    // Migrate GITHUB_TOKEN → GITHUB_PERSONAL_ACCESS_TOKEN in stored config
    const needsGithubMigration = cfg.mcp_servers.some(
      (s) => s.name === 'github' && s.env?.GITHUB_TOKEN && !s.env?.GITHUB_PERSONAL_ACCESS_TOKEN
    )
    if (needsGithubMigration) {
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

    // Migrate stale Slack configs: old @modelcontextprotocol/server-slack entries and
    // new slack-mcp-server entries that were saved without the required --transport stdio flag.
    const needsSlackMigration = cfg.mcp_servers.some(
      (s) => s.name === 'slack' && !(s.args ?? []).includes('--transport')
    )
    if (needsSlackMigration) {
      updateConfig({
        mcp_servers: cfg.mcp_servers.map((s) => {
          if (s.name !== 'slack') return s
          const oldEnv = s.env ?? {}
          // Preserve xoxp token if already present; drop legacy bot token + team id
          const newEnv: Record<string, string> = { SLACK_MCP_ADD_MESSAGE_TOOL: 'true' }
          if (oldEnv.SLACK_MCP_XOXP_TOKEN) newEnv.SLACK_MCP_XOXP_TOKEN = oldEnv.SLACK_MCP_XOXP_TOKEN
          return {
            ...s,
            args: ['-y', 'slack-mcp-server@latest', '--transport', 'stdio'],
            env: newEnv
          }
        })
      })
      cfg = readConfig()
      console.log('[mcp] migrated slack: updated to slack-mcp-server with --transport stdio')
    }

    for (const srv of cfg.mcp_servers) {
      try {
        await connectServer(srv)
        console.log(`[mcp] connected: ${srv.name}`)
      } catch (err) {
        console.error(`[mcp] failed to connect ${srv.name}:`, err)
      }
    }
  })
}

/**
 * Test or restore a single named server's connection and return its live status.
 * This is the authoritative "Test connection" action — it uses the real connection Map
 * so the dot/tool-count in the UI reflects exactly what routines and ambient will use.
 *
 * Non-destructive when the server is already connected: probes the live client with a
 * listTools call rather than tearing the connection down and rebuilding it. Only falls
 * back to a full reconnect when the server is not in the Map or when the probe fails.
 */
export async function reconnectServer(name: string): Promise<McpServerStatus> {
  const cfg = readConfig()
  const srv = cfg.mcp_servers.find((s) => s.name === name)
  if (!srv) {
    return { name, connected: false, tools: [] }
  }
  return runExclusive(async () => {
    // If the server is already connected, probe the live client with a listTools call.
    // This is non-destructive — we don't kill the connection that routines/ambient use.
    const active = servers.get(name)
    if (active) {
      try {
        const toolsResult = await withTimeout(
          active.client.listTools(),
          30_000,
          `listTools ${name}`
        )
        const tools: McpTool[] = (toolsResult.tools ?? []).map((t) => ({
          name: t.name,
          description: t.description ?? '',
          inputSchema: (t.inputSchema as Record<string, unknown>) ?? {}
        }))
        active.tools = tools  // refresh cached tool list in place
        console.log(`[mcp] tested: ${name} (${tools.length} tools)`)
        return { name, connected: true, tools }
      } catch {
        // Probe failed — fall through to a full reconnect
        console.warn(`[mcp] probe failed for ${name}, attempting full reconnect`)
      }
    }
    // Not connected, or live probe failed: full disconnect + reconnect
    try {
      const tools = await connectServer(srv)
      console.log(`[mcp] reconnected: ${name}`)
      return { name, connected: true, tools }
    } catch (err: any) {
      console.error(`[mcp] reconnect failed: ${name}:`, err)
      // Take only the first line for the UI — the enriched error may contain
      // a multi-line stderr tail that is for console diagnostics, not user display.
      const rawMsg = err?.message ?? String(err)
      return { name, connected: false, tools: [], error: rawMsg.split('\n')[0] }
    }
  })
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

