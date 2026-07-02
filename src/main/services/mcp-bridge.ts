import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { getServerStatus, callToolRaw } from './mcp'
import { logError } from './logger'

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
    // mypa_builtin is reserved for the in-process ask_user server added by
    // buildAskUserServer(). A user-configured server that sanitizes to the same
    // key would silently overwrite it in allMcpServers and bypass canUseTool
    // write-gating. Skip it instead of producing an unpredictable collision.
    if (safeName === 'mypa_builtin') continue
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
    //
    // Two hardening layers applied before returning to the SDK's internal MCP
    // client (which may be a much older version than mypa's @modelcontextprotocol/sdk):
    //
    //  1. try/catch: a thrown callToolRaw (timeout, dead connection, unexpected
    //     rejection) is converted to a valid MCP error result rather than an
    //     opaque protocol error that the model would narrate as a ZodError.
    //
    //  2. Normalization: strip fields that an older MCP client validator may not
    //     recognise (structuredContent, _meta, non-text content variants) so the
    //     response shape is stable across SDK versions.
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const toolLabel = `${originalName}::${req.params.name}`
      let raw: Awaited<ReturnType<typeof callToolRaw>>
      try {
        raw = await callToolRaw(
          originalName,
          req.params.name,
          (req.params.arguments ?? {}) as Record<string, unknown>,
        )
      } catch (err) {
        logError('bridge', `tool call failed: ${toolLabel}`, err)
        return {
          content: [{ type: 'text' as const, text: (err instanceof Error ? err.message : String(err)) }],
          isError: true,
        }
      }

      // Normalize: keep only text/image content blocks; stringify everything
      // else.  This drops structuredContent, _meta, and any future unknown
      // fields that an older embedded MCP client might reject with a ZodError.
      const normalizedContent = (raw.content ?? []).map((block: unknown) => {
        const b = block as Record<string, unknown>
        if (b.type === 'text') return { type: 'text' as const, text: String(b.text ?? '') }
        // Only pass through image blocks when both required fields are present strings;
        // a malformed block missing data or mimeType would fail SDK Zod validation.
        if (b.type === 'image' && typeof b.data === 'string' && typeof b.mimeType === 'string')
          return { type: 'image' as const, data: b.data, mimeType: b.mimeType }
        // Stringify unknown block types (resource links, embedded docs, malformed images, etc.)
        return { type: 'text' as const, text: JSON.stringify(b) }
      })

      if (raw.isError) {
        const errorText = normalizedContent
          .filter((b) => b.type === 'text')
          .map((b) => (b as { type: 'text'; text: string }).text)
          .join('\n')
        logError('bridge', `tool returned isError: ${toolLabel}`, errorText || '(no text content)')
      }

      return { content: normalizedContent, isError: raw.isError ?? false }
    })

    result[safeName] = { type: 'sdk', name: safeName, instance: server }
  }

  return result
}
