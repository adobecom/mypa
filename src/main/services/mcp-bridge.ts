import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { getServerStatus, callToolRaw } from './mcp'

/**
 * Builds one in-process MCP proxy server per connected entry in the warm pool.
 *
 * Returns a map from sanitized server name → `{ type: 'sdk', name, instance }`,
 * the variant the Agent SDK accepts for servers it should NOT cold-spawn.  The SDK
 * only ever calls `instance.connect(transport)` on these objects, so the full
 * subprocess-spawn + listTools cold-boot is eliminated for every chat turn.
 *
 * Each proxy:
 *   - Serves `tools/list` from the cached tool list (no upstream round-trip).
 *   - Forwards `tools/call` to the live pooled client via `callToolRaw`.
 *
 * Disconnected or disabled servers are simply absent from the returned map —
 * the chat turn proceeds immediately without hanging on unreachable servers.
 *
 * Server key sanitization uses the same `replace(/[^a-zA-Z0-9_-]/g, '_')` rule
 * previously applied when building stdio configs, so tool names remain in the
 * `mcp__<safeName>__<tool>` format that `canUseTool` already expects.
 */
export function buildBridgedMcpServers(): Record<string, { type: 'sdk'; name: string; instance: Server }> {
  const statuses = getServerStatus()
  const result: Record<string, { type: 'sdk'; name: string; instance: Server }> = {}

  for (const status of statuses) {
    // Skip disconnected and disabled servers — do NOT hand the SDK a server it
    // cannot reach; that was the original cause of the cold-boot hang.
    if (!status.connected || status.tools.length === 0) continue

    const safeName = status.name.replace(/[^a-zA-Z0-9_-]/g, '_')
    const originalName = status.name
    // Snapshot cached tools at bridge-build time so this chat turn has a
    // consistent view even if the pool refreshes mid-stream.
    const cachedTools = status.tools

    const server = new Server(
      { name: `mypa-bridge-${safeName}`, version: '0.1.0' },
      { capabilities: { tools: {} } },
    )

    // Serve the cached tool list in-process — no upstream round-trip, no latency.
    // inputSchema is a raw JSON Schema object; ListToolsResultSchema uses a
    // $catchall(ZodUnknown) on inputSchema so arbitrary schemas pass through.
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: cachedTools.map((t) => ({
        name: t.name,
        description: t.description,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        inputSchema: t.inputSchema as any,
      })),
    }))

    // Forward tool calls to the live pooled client.  The closure captures the
    // original (unsanitized) pool key so the correct ActiveServer is looked up.
    server.setRequestHandler(CallToolRequestSchema, async (req) =>
      callToolRaw(
        originalName,
        req.params.name,
        (req.params.arguments ?? {}) as Record<string, unknown>,
      ),
    )

    result[safeName] = { type: 'sdk', name: safeName, instance: server }
  }

  return result
}
