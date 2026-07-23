import { homedir } from 'os'
import { join } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { readConfig, updateConfig } from './config'
import type { McpServerConfig, McpTool, McpServerStatus, ResolvedOwnerHandles, IdentitySurface } from '@shared/types'
import { IDENTITY_SURFACES } from '@shared/types'
import { MCP_CATALOG } from '@shared/mcp-catalog'

interface ActiveServer {
  client: Client
  transport: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport
  tools: McpTool[]
  config: McpServerConfig
}

const servers = new Map<string, ActiveServer>()
// Last-known connection error per server name; cleared on successful (re)connect.
const serverErrors = new Map<string, string>()

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
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
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

  const client = new Client(
    { name: 'mypa', version: '0.1.0' },
    { capabilities: {} }
  )

  // Determine transport from explicit field or infer: stdio when command present, http otherwise
  const transportKind = cfg.transport ?? (cfg.command ? 'stdio' : 'http')

  // Stdio-only diagnostic ring buffer for timeout error messages
  const stderrLines: string[] = []

  let transport: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport

  if (transportKind === 'stdio') {
    const mergedEnv = { ...process.env, ...(cfg.env ?? {}) } as Record<string, string>
    // Backward compat: server-github reads GITHUB_PERSONAL_ACCESS_TOKEN, not GITHUB_TOKEN
    if (mergedEnv.GITHUB_TOKEN && !mergedEnv.GITHUB_PERSONAL_ACCESS_TOKEN) {
      mergedEnv.GITHUB_PERSONAL_ACCESS_TOKEN = mergedEnv.GITHUB_TOKEN
    }
    // slack-mcp-server needs on-disk user/channel caches to resolve names and to make
    // channels_list functional at all (without them it falls back to per-message
    // lookups and channels_list is documented as non-functional). Point both at our
    // own data dir when the user hasn't already overridden them, so they persist
    // across restarts and don't need any onboarding step.
    if (cfg.name === 'slack') {
      const slackCacheDir = join(homedir(), '.mypa')
      if (!mergedEnv.SLACK_MCP_USERS_CACHE) {
        mergedEnv.SLACK_MCP_USERS_CACHE = join(slackCacheDir, 'slack-users-cache.json')
      }
      if (!mergedEnv.SLACK_MCP_CHANNELS_CACHE) {
        mergedEnv.SLACK_MCP_CHANNELS_CACHE = join(slackCacheDir, 'slack-channels-cache.json')
      }
    }
    const stdioTransport = new StdioClientTransport({
      command: cfg.command!,
      args: expandTildeArgs(cfg),
      env: mergedEnv,
      stderr: 'pipe'  // pipe instead of inherit so we can re-emit with a prefix and
                      // keep a diagnostic tail for timeout error messages
    })
    // Re-emit subprocess stderr line-by-line with a server-name prefix (preserves the
    // visibility that 'inherit' provided) and keep a 30-line ring buffer so that a
    // genuine timeout can report what the server last printed before stalling.
    stdioTransport.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      for (const line of text.split('\n')) {
        if (line) {
          try { process.stderr.write(`[mcp:${cfg.name}] ${line}\n`) } catch {}
          stderrLines.push(line)
          if (stderrLines.length > 30) stderrLines.shift()
        }
      }
    })
    transport = stdioTransport
  } else if (transportKind === 'sse') {
    if (!cfg.url) throw new Error(`MCP server "${cfg.name}" has transport "sse" but no url`)
    transport = new SSEClientTransport(new URL(cfg.url), {
      ...(cfg.headers ? { requestInit: { headers: cfg.headers } } : {})
    })
  } else {
    // http / streamable-http
    if (!cfg.url) throw new Error(`MCP server "${cfg.name}" has transport "http" but no url`)
    transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
      ...(cfg.headers ? { requestInit: { headers: cfg.headers } } : {})
    })
  }

  // Wrap connect + listTools in a try/catch so that if either times out we
  // close the client (which terminates the spawned subprocess / HTTP session) before
  // throwing. Without this the connection is orphaned — it never lands in servers.Map
  // so disconnectServer() cannot find and kill it on subsequent reconnect attempts.
  try {
    await withTimeout(client.connect(transport), 30_000, `connect ${cfg.name}`)

    const toolsResult = await withTimeout(client.listTools(), 30_000, `listTools ${cfg.name}`)
    const tools: McpTool[] = (toolsResult.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? {}
    }))

    servers.set(cfg.name, { client, transport, tools, config: cfg })
    // Auto-evict from the Map when the subprocess/connection dies so that subsequent
    // callTool calls don't silently hit a dead client. The guard prevents double-eviction
    // if a concurrent reconnect has already replaced this entry with a fresh one.
    client.onclose = () => {
      if (servers.get(cfg.name)?.client === client) {
        servers.delete(cfg.name)
        console.log(`[mcp:${cfg.name}] disconnected`)
      }
    }
    return tools
  } catch (err) {
    // For stdio servers, enrich the error with the last stderr lines from the subprocess.
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

const DEFAULT_TOOL_CALL_TIMEOUT_MS = 30_000
// Per-server overrides for the default tool-call timeout. Slack's xoxp-token fallback
// path for tools like conversations_unreads makes one Slack API call per channel and
// is documented as slower on large workspaces — 30s isn't enough headroom there even
// with the on-disk cache warmed up, so give it more room before mypa gives up. (Live
// probe on an enterprise workspace hit the MCP SDK's own 60s default request timeout
// before this override existed — see the note on the `timeout` option below — so this
// needs real room past that, not just past our own 30s default.)
const TOOL_CALL_TIMEOUT_MS: Record<string, number> = {
  slack: 150_000,
}

// Shared by callTool/callToolRaw. The MCP SDK's `Client.callTool()` return type
// widens to `{}` once piped through the generic `withTimeout<T>` wrapper (a TS
// inference quirk with its structurally-indexed result type), so the actual
// runtime shape — always CallToolResult for a plain callTool() invocation with
// no custom resultSchema — has to be asserted once, here, rather than at every
// call site.
async function callToolTimed(
  serverName: string,
  toolName: string,
  params: Record<string, unknown>
): Promise<CallToolResult> {
  const server = servers.get(serverName)
  if (!server) throw new Error(`MCP server "${serverName}" not connected`)
  const timeoutMs = TOOL_CALL_TIMEOUT_MS[serverName] ?? DEFAULT_TOOL_CALL_TIMEOUT_MS
  // The MCP SDK's own Client.callTool() has an internal default request timeout
  // (DEFAULT_REQUEST_TIMEOUT_MSEC = 60_000, see protocol.js) that fires independently
  // of our withTimeout race below — a per-server override above 60s does nothing
  // unless it's also passed through here, since the SDK's own timer would otherwise
  // still reject first at 60s and surface as "MCP error -32001: Request timed out"
  // instead of ever reaching our timeoutMs.
  return (await withTimeout(
    server.client.callTool({ name: toolName, arguments: params }, undefined, { timeout: timeoutMs }),
    timeoutMs,
    `callTool ${serverName}::${toolName}`
  )) as CallToolResult
}

export async function callTool(
  serverName: string,
  toolName: string,
  params: Record<string, unknown>
): Promise<string> {
  const result = await callToolTimed(serverName, toolName, params)
  const content = result.content ?? []
  const text = content
    .map((c: any) => (c.type === 'text' ? c.text : JSON.stringify(c)))
    .join('\n')
  // Propagate server-reported tool errors so callers (routines, ambient) surface
  // them as exceptions rather than silently treating error payloads as success.
  if (result.isError) throw new Error(text || `Tool ${toolName} reported an error`)
  return text
}

/** Forwards a tool call to the warm pooled client and returns the raw MCP result
 *  (content blocks + isError preserved), for the in-process SDK bridge proxy.
 *  Unlike callTool, this does NOT flatten to a string or throw on isError — the
 *  SDK bridge needs the raw shape so the model can see the error content. */
export async function callToolRaw(
  serverName: string,
  toolName: string,
  params: Record<string, unknown>,
): Promise<CallToolResult> {
  return callToolTimed(serverName, toolName, params)
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
      // Skip servers that are intentionally disabled
      if (srv.enabled === false) {
        await disconnectServer(srv.name)
        console.log(`[mcp] skipped (disabled): ${srv.name}`)
        continue
      }
      try {
        await connectServer(srv)
        serverErrors.delete(srv.name)
        console.log(`[mcp] connected: ${srv.name}`)
      } catch (err) {
        const errMsg = String((err as Error)?.message ?? err).split('\n')[0]
        serverErrors.set(srv.name, errMsg)
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
        serverErrors.delete(name)
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
      serverErrors.delete(name)
      console.log(`[mcp] reconnected: ${name}`)
      return { name, connected: true, tools }
    } catch (err: any) {
      console.error(`[mcp] reconnect failed: ${name}:`, err)
      // Take only the first line for the UI — the enriched error may contain
      // a multi-line stderr tail that is for console diagnostics, not user display.
      const rawMsg = err?.message ?? String(err)
      const errMsg = rawMsg.split('\n')[0]
      serverErrors.set(name, errMsg)
      return { name, connected: false, tools: [], error: errMsg }
    }
  })
}

export async function disconnectAllServers(): Promise<void> {
  // Parallel, not sequential — a caller (e.g. app quit) bounding this with an
  // overall timeout otherwise only reaches as many servers as fit before the
  // deadline in loop order, orphaning the rest.
  await Promise.allSettled([...servers.keys()].map((name) => disconnectServer(name)))
}

export function getServerStatus(): McpServerStatus[] {
  const cfg = readConfig()
  return cfg.mcp_servers.map((srv) => {
    if (srv.enabled === false) {
      return { name: srv.name, connected: false, tools: [], disabled: true }
    }
    const active = servers.get(srv.name)
    const lastError = active ? undefined : serverErrors.get(srv.name)
    return {
      name: srv.name,
      connected: !!active,
      tools: active?.tools ?? [],
      ...(lastError ? { error: lastError } : {}),
    }
  })
}

/**
 * Best-effort reconnect of any configured server that is not currently in the
 * live Map. Called before MCP-enabled chat turns so that `callTool` (in-process
 * execution) and --allowedTools (CLI allowlist) stay as fresh as possible.
 * Errors are logged and swallowed — a failed reconnect is not fatal.
 */
export async function ensureServersConnected(): Promise<void> {
  const cfg = readConfig()
  const dead = cfg.mcp_servers.filter((srv) => srv.enabled !== false && !servers.has(srv.name))
  if (dead.length === 0) return
  await Promise.all(dead.map(async (srv) => {
    try {
      await reconnectServer(srv.name)
    } catch (err) {
      console.warn(`[mcp] ensureServersConnected: could not reconnect ${srv.name}:`, err)
    }
  }))
}

// ─── Owner identity resolution ────────────────────────────────────────────────

const SURFACE_NAMES = IDENTITY_SURFACES
type SurfaceName = IdentitySurface

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

