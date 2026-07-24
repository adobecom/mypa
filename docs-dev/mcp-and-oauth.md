# MCP & OAuth

## MCP (Model Context Protocol)

mypa connects to MCP servers using `@modelcontextprotocol/sdk`. Three transports are supported: stdio (local subprocess), HTTP (Streamable HTTP), and SSE (HTTP+SSE). Each server provides tools that routines and plan actions call.

**Source files:**
- `src/main/services/mcp.ts` — client manager
- `src/main/services/mcp-bridge.ts` — in-process proxy bridge for Agent SDK chat turns
- `src/main/services/claude-import.ts` — Claude Code config import
- `src/shared/mcp-catalog.ts` — built-in server catalog
- `src/shared/types.ts` — `McpServerConfig`, `McpTool`, `McpServerStatus`, `DetectedMcpServer`

---

### Server configuration (`McpServerConfig`)

```ts
interface McpServerConfig {
  name:       string
  command?:   string                    // executable — required for stdio; absent for http/sse
  args?:      string[]
  env?:       Record<string, string>    // encrypted at rest with safeStorage
  enabled?:   boolean                   // false = configured but not connected (default true)
  transport?: 'stdio' | 'http' | 'sse' // defaults to 'stdio' when command present, 'http' when url present
  url?:       string                    // required for http and sse transports
  headers?:   Record<string, string>    // optional auth headers sent with every request
}
```

Servers are stored in `AppConfig.mcp_servers`. Env var values with an `enc:` prefix are decrypted before being passed to the subprocess (see [configuration.md](configuration.md)).

**Transport selection** — `connectServer` infers the transport when `transport` is absent: stdio when `command` is present, HTTP when `url` is present. Explicit `transport: 'sse'` selects the older HTTP+SSE transport (for servers that predate the Streamable HTTP spec).

---

### MCP client manager (`mcp.ts`)

Maintains a `Map<string, Client>` of active connections keyed by server name.

| Export | Description |
|---|---|
| `connectServer(cfg)` | Spawn the server process, establish stdio transport, list available tools, cache the client |
| `disconnectServer(name)` | Gracefully close the transport, remove from cache |
| `connectAllServers()` | Called at startup and on every `config:update` — iterates `config.mcp_servers`, connects all; serialized via mutex |
| `reconnectServer(name)` | Test or restore one named server under the mutex; returns `McpServerStatus`. When already connected, probes the live client with `listTools` (non-destructive); falls back to a full reconnect only when the server is not in the Map or the probe fails. This is the "Test connection" IPC action — the UI dot always reflects the actual live state. |
| `disconnectAllServers()` | Called at shutdown |
| `callTool(server, tool, params)` | Call a tool on a connected server; throws if server not found or if `result.isError` is truthy |
| `callToolRaw(server, tool, params)` | Like `callTool` but returns the raw MCP result (`{ content, isError? }`) without flattening or throwing on `isError`; used by the in-process SDK bridge |
| `getServerStatus()` | Return `McpServerStatus[]` from the in-memory Map (no reconnect); disabled servers appear with `connected: false, disabled: true`; disconnected servers include `error` from the module-level `serverErrors` Map if a last failure was recorded |
| `ensureServersConnected()` | Best-effort reconnect of any configured (and not-disabled) server not in the live Map; called before MCP-enabled chat turns |

**Concurrency:** a module-level `connectQueue` promise chain serializes `connectAllServers()` and `reconnectServer()`. Two near-simultaneous `config:update` calls (e.g. rapid saves or OAuth reconnect overlapping a save) cannot race and destroy each other's live connections.

**Stderr capture:** `connectServer` passes `stderr: 'pipe'` to the `StdioClientTransport`. A `data` listener re-emits each line to `process.stderr` with a `[mcp:<name>]` prefix (matching the visibility that `'inherit'` previously provided) and keeps a bounded 30-line ring buffer. When a `connect` or `listTools` timeout fires, the last 5 buffered lines are appended to the error message so the user sees what the server was doing before it stalled.

**Backward compat:**
- GitHub: if a server's env contains `GITHUB_TOKEN` but not `GITHUB_PERSONAL_ACCESS_TOKEN`, the value is copied under the new key automatically. (GitHub is now a plain PAT/`api_key` catalog entry — see below — but this migration still applies to any server whose env still uses the old `GITHUB_TOKEN` key.)
- Slack: if a stored slack server's `args` do not include `--transport`, `connectAllServers` rewrites the entry to `['-y', 'slack-mcp-server@latest', '--transport', 'stdio']`, preserves `SLACK_MCP_XOXP_TOKEN` if present, and injects `SLACK_MCP_ADD_MESSAGE_TOOL=true`. This auto-migrates entries created before the `--transport stdio` requirement was added without requiring a manual re-add.

**Slack cache files:** `connectServer` also injects `SLACK_MCP_USERS_CACHE` and `SLACK_MCP_CHANNELS_CACHE` (both pointed at `~/.mypa/slack-{users,channels}-cache.json`) into the slack server's env when not already set. `slack-mcp-server` needs these on-disk caches to resolve user/channel names — without them `channels_list` doesn't work at all, and tools like `conversations_unreads` fall back to a slower per-item lookup path. The paths are injected at spawn time rather than baked into the catalog's `fixedEnv` so the absolute home-dir path never lands in stored config and existing installs pick it up with no migration step.

**Tool-call timeouts:** `callToolTimed` (shared by `callTool`/`callToolRaw`) resolves its timeout from a per-server override map, falling back to the 30 s default described above. Slack is currently the only override, at 150 s: with an `xoxp` user token, `slack-mcp-server`'s tools like `conversations_unreads` fall back to one Slack API call per channel and are documented upstream as slower on large workspaces, so 30 s isn't reliable headroom even once the on-disk cache is warm. The override is passed through as `RequestOptions.timeout` on `client.callTool()` itself, not just raced via `withTimeout` — the MCP SDK's `Client` has its own internal default request timeout (`DEFAULT_REQUEST_TIMEOUT_MSEC`, 60 s) that fires independently and would otherwise still cut a long-running call off at 60 s regardless of a larger `withTimeout` value, surfacing as `MCP error -32001: Request timed out` instead of ever reaching the intended override.

---

### Built-in catalog (`mcp-catalog.ts`)

`src/shared/mcp-catalog.ts` exports a list of pre-configured MCP server templates users can add in one click from the Settings panel. Each entry includes the command, args template, required env keys, and an OAuth provider hint (if applicable).

#### `ArgInput` — positional argument collection

Some catalog entries need positional CLI arguments rather than env vars. The `argInputs?: ArgInput[]` field on `McpCatalogEntry` declares these:

```ts
interface ArgInput {
  label: string
  placeholder?: string
  hint?: string
  multiple?: boolean  // allow one or more rows
  isPath?: boolean    // values are filesystem directory paths — enables Browse button
                      // and tilde expansion at connect time
}
```

When `isPath: true`, the renderer shows a **Browse…** button (native `dialog.showOpenDialog`) alongside the text inputs. Paths selected via the picker are always absolute. Manually typed paths must start with `/` or `~` — the "Add" button stays disabled while any non-empty value fails this check.

Tilde expansion (`~` → `os.homedir()`) is applied in `mcp.ts` at connect time (not stored), so the persisted value remains portable.

#### Filesystem server

The `filesystem` catalog entry (`id: 'filesystem'`, `@modelcontextprotocol/server-filesystem`) uses `argInputs` to collect one or more **allowed directories**. These become positional `argv` after the package name:

```
npx -y @modelcontextprotocol/server-filesystem <dir1> [<dir2> ...]
```

The server can only read/write within the listed directories. No environment variables are required (`authType: 'none'`).

**Health validation:** `setup.getHealth()` (`setup:get-health` IPC) validates that:
- At least one directory is configured.
- Each directory (after tilde expansion) exists and is a real directory.

Failures are reported in `SetupHealthServer.invalidArgs` and surfaced in the Setup Health card.

**Claude-import path:** Filesystem servers imported from `~/.claude.json` carry their `args` verbatim (including any allowed directories already configured there). Tilde expansion still applies at connect time.

---

#### GitHub — personal access token

The `github` catalog entry (`id: 'github'`, `@modelcontextprotocol/server-github`) is `authType: 'api_key'`, not OAuth — GitHub organizations can enforce OAuth-app access-control policies that block a device-flow/OAuth-app connection outright, so a PAT is the only setup path that reliably works across org policies. It requires one `requiredEnv` field:

| Key | Label | Hint |
|---|---|---|
| `GITHUB_PERSONAL_ACCESS_TOKEN` | Personal access token | Recommends a fine-grained token (Contents/Metadata/Issues/Pull requests, read-only, scoped to selected repos) first, with a classic token (`repo`, `read:user` scopes) as the fallback; calls out that org SSO/OAuth policies may require admin approval (fine-grained) or per-token SSO authorization (classic). |

This mirrors the Slack entry's pattern of a `requiredEnv` field with a detailed `hint` instead of an OAuth "Connect" button (see the Slack entry in `mcp-catalog.ts`). The `ServerCatalogPicker` renders it via the generic API-key field path (one password input per `requiredEnv` entry) — no GitHub-specific UI exists. `GITHUB_PERSONAL_ACCESS_TOKEN` is unchanged from the prior OAuth-era env key, so existing configured tokens keep working after this change.

---

#### Outlook — device-code sign-in, no OAuth handshake

The `outlook` catalog entry (`id: 'outlook'`, `@softeria/ms-365-mcp-server --org-mode`) is `authType: 'device_code'` — a third auth mode alongside `oauth`/`api_key`/`none`. Unlike Notion/Linear, mypa does **not** perform the Microsoft OAuth handshake itself: Microsoft Graph access tokens expire in about an hour and mypa's PKCE flow (below) has no refresh-token support, so implementing it directly would mean re-authenticating constantly. Instead the MCP server owns its own login end-to-end — it runs Microsoft's MSAL device-code flow and caches (and silently refreshes) the token on disk. mypa's only job is to run the server's `--login` step, surface the device code it prints, and wait for the process to exit.

`requiredEnv` on this entry (`MS365_MCP_CLIENT_ID`, `MS365_MCP_TENANT_ID`) are both `optional: true` — the server ships with a built-in multi-tenant Azure app that works out of the box for personal and most work accounts. They only need to be filled in when an org's conditional access / admin consent policy blocks that built-in app, in which case the user registers their own public-client Azure app and pastes its client ID (and tenant ID) here.

See [Outlook — device-code flow](#outlook--device-code-flow) below for the full mechanism.

---

### Claude Code config import (`claude-import.ts`)

`detectClaudeMcp()` (called from `setup.detectClaudeMcp()` IPC) looks for an existing Claude Code configuration file at known paths and returns `DetectedMcpServer[]` that can be imported into mypa with one click:

```ts
interface DetectedMcpServer {
  name:      string
  command?:  string
  args?:     string[]
  env?:      Record<string, string>
  type:      string     // 'stdio' | 'http' | 'sse'
  supported: boolean    // true only for stdio servers
}
```

Only `supported: true` servers (stdio) can be imported.

---

## OAuth

mypa supports OAuth authentication for Notion and Linear to enrich routines with live data from those services. GitHub is **not** an OAuth entry — see [GitHub — personal access token](#github--personal-access-token) below.

**Source files:**
- `src/main/services/oauth.ts` — flow implementations
- `src/shared/types.ts` — `OAuthProvider`, `OAuthAppCredential`

OAuth tokens are stored in `AppConfig.oauth_connected_at` (timestamp) and passed as env vars to the relevant MCP server. Client secrets are encrypted at rest with Electron `safeStorage`.

---

### Redirect URI

All PKCE flows use the custom URL scheme:

```
mypa://oauth/callback
```

This scheme is registered in `package.json → build.protocols` and handled in the main process via Electron's `open-url` event. The `handleOAuthCallback(url)` function:
1. Parses the `code` and `state` query parameters.
2. **Validates the `state` nonce** against the one generated at flow start to prevent authorization code injection attacks.
3. Exchanges the code for an access token using the PKCE code verifier.

---

### Notion & Linear — PKCE flow

Used for services that support the standard OAuth 2.0 authorization code + PKCE flow.

```
startPkce(provider: 'notion' | 'linear') → authorizationUrl
```

Steps:
1. Generate a random `state` nonce and `code_verifier` (stored in memory for the callback).
2. Compute `code_challenge = base64url(sha256(code_verifier))`.
3. Build the authorization URL with `response_type=code`, `code_challenge`, `code_challenge_method=S256`, `redirect_uri=mypa://oauth/callback`, and the `state` nonce.
4. The UI opens this URL in the system browser.
5. When the user completes auth, the browser redirects to `mypa://oauth/callback?code=…&state=…`.
6. `handleOAuthCallback(url)` validates the state and exchanges the code for a token using the stored verifier.

Provider configurations (client IDs, scopes, token endpoints) live in `src/shared/oauth-config.ts`.

---

### Outlook — device-code flow

Used for the `outlook` catalog entry ([above](#outlook--device-code-sign-in-no-oauth-handshake)), where mypa never handles a Microsoft token directly — the MCP server's own login command does.

```
startDeviceLogin(entryId: string, env: Record<string, string>) → void
```

Steps (`oauth.ts`):
1. `ipc-handlers.ts` looks up the catalog entry and spawns `<command> [...baseArgs, '--login']` (e.g. `npx -y @softeria/ms-365-mcp-server --org-mode --login`) with the user's optional client-id/tenant-id overrides merged into its env, plus a pinned `MS365_MCP_TOKEN_CACHE_PATH` (`~/.mypa/ms365-token-cache.json`, same path `mcp.ts` injects when connecting the server, so login and the live server share one cache). The spawned child is tracked in a module-level `activeLogins` set purely so `killActiveDeviceLogins()` can terminate any still-running login on app quit (mirroring `mcp.ts`'s `disconnectAllServers` on the same quit path) — it plays no role in the login flow itself.
2. `startDeviceLogin` watches the child's combined stdout/stderr for MSAL's device-code prompt (`open the page <url> ... enter the code <code>`) via a tolerant regex — not an exact string match, since the prompt text is MSAL-owned. `--login` always initiates a fresh MSAL device-code request — the CLI login step has no cache-first shortcut, so every click of "Connect" requires the user to complete the browser step once, even if a still-valid cached token already exists. (The cache pays off afterward: the *connected* MCP server process reads it silently on every tool call without ever needing to re-run `--login`.)
3. On first match, it broadcasts `oauth:device-code` (`{ entryId, userCode, verificationUri }`) to all windows and — after checking the captured URL starts with `https://` or `http://`, mirroring the same scheme guard `system:open-external` applies to renderer-supplied URLs, since this one instead comes from parsing subprocess output — opens it in the system browser.
4. The renderer (`ServerCatalogPicker`'s `device_code` branch) shows the code (with a copy button) and a manual "Open sign-in page" fallback link. Any optional advanced fields (custom Azure client/tenant id) render *above* the Connect button, not below, so an org that needs them sees them before the first sign-in attempt; they're disabled once sign-in succeeds so a later edit can't silently save a server config pointing at a different app/tenant than the one just signed into.
5. The promise resolves when the child process exits 0 and records `device_login_at[entryId]` in config for a "Connected on <date>" display. A non-zero exit or a 15-minute timeout rejects with the process's recent output.

No token is ever returned to or stored by mypa — `handleAdd` in `ServerCatalogPicker` saves the server config as-is (command/args/optional env overrides only) once `deviceLoginDone` is true.

---

### Connection status

`SetupHealth.servers[]` (from `setup.getHealth()`) reports per-server health:

| Field | Description |
|---|---|
| `connected` | Whether the server process is currently connected |
| `missingEnvKeys` | Required env vars not yet configured (empty array if all present) |
| `invalidArgs` | Path-type arg problems: missing dirs, non-existent paths, relative paths (undefined if clean) |
| `oauthProvider` | Which OAuth provider the server uses (if any) |
| `oauthConnectedAt` | ISO timestamp of last successful auth |
| `oauthStaleDays` | Days since last auth (if stale, show re-auth prompt) |

## MCP in the Agent SDK

### Chat turns — in-process bridge (zero cold-boot)

For streaming chat (`streamAgentChat`), MCP servers are **not** passed as stdio/http/sse configs that the SDK would cold-spawn. Instead, `agent.ts` uses `src/main/services/mcp-bridge.ts` to build in-process proxy servers from the already-warm connection pool:

```
mcp.ts warm pool ──► buildBridgedMcpServers() ──► { type: 'sdk', instance: Server }[] ──► SDK query()
```

`buildBridgedMcpServers()` iterates `getServerStatus()` and, for each connected server, creates a low-level `Server` (`@modelcontextprotocol/sdk/server/index.js`) with two request handlers:
- `tools/list` — served from the cached tool list, in-process, with zero upstream round-trips. The raw JSON Schema in each tool's `inputSchema` passes through verbatim (the SDK's `ListToolsResultSchema` uses a `$catchall(ZodUnknown)` on `inputSchema`, so no Zod conversion is needed).
- `tools/call` — forwarded to the live pooled client via `callToolRaw`.

The SDK sees `{ type: 'sdk', name, instance }` entries and calls `instance.connect(transport)` — no subprocess is ever spawned for these servers. Disconnected or disabled servers are simply absent from the map (the SDK never waits for them).

Before building the bridge, `agent.ts` calls `ensureServersConnected()` to best-effort reconnect any pool entry that has gone dead since boot.

**Startup latency:** previously, every chat turn cold-spawned `N` stdio subprocesses (npx download + auth + listTools per server) before the first token, burning up to 140 s of the startup budget. With the bridge, the startup cost drops to zero — the pool is already connected at app boot.

**Server key format:** sanitized with `replace(/[^a-zA-Z0-9_-]/g, '_')`, same rule as before, so tool names remain `mcp__<safeName>__<tool>` and the `canUseTool` write-gate is unaffected.

### One-shot MCP (`runAgentWithMcp`)

The less-frequent one-shot MCP path (used for ambient `suggest` tasks) still passes stdio configs directly via `options.mcpServers` — it does not use the bridge. Cold-boot cost there is acceptable since these calls run on a 5-minute background interval, not interactively.

### `canUseTool` gating

Applied for both paths:
- Server key `mypa_builtin` — always allowed (the in-process `ask_user` tool).
- Read-only tool names (prefix: `get`, `list`, `search`, `read`, `fetch`, `find`, `describe`, `view`, `show`, `check`, `query`, `lookup`) are auto-allowed — **unless** a subsequent name component is a write verb (`create`, `update`, `delete`, etc.).
- All other tools block the stream and broadcast `chat:tool-approval-request` until the user responds via `resolveToolApproval()`.

The in-process `ask_user` MCP server (created by `buildAskUserServer`) is registered under server key `mypa_builtin` and is always allowed by `canUseTool`.

This blocking wait (and the equivalent one in `ask_user`) is covered by a human-wait latch in `streamAgentChatOnce` that keeps the idle timer from mistaking a slow human for a stalled model/tool — see [claude-integration.md](claude-integration.md#streamagentchat--streaming-multi-turn-chat) for the full mechanism and its 30-minute absolute cap.

## Changelog

- 2026-07-23 — **Add Outlook connector via device-code sign-in (`mcp-catalog.ts`, `oauth.ts`, `mcp.ts`, `ipc-handlers.ts`, `preload/index.ts`, `types.ts`, `index.ts`, `ServerCatalogPicker.tsx`):** New `outlook` catalog entry (`@softeria/ms-365-mcp-server --org-mode`) for Microsoft 365 email/calendar. Added a third `McpCatalogEntry.authType`, `'device_code'`, alongside `oauth`/`api_key`/`none` — used because Microsoft Graph tokens expire hourly and mypa's PKCE flow has no refresh-token support, so the MCP server (not mypa) owns the full Microsoft login/refresh lifecycle via its own `--login` MSAL device-code flow. New `oauth.ts` export `startDeviceLogin(entryId, command, args, env)` spawns that login command, parses the device code + verification URL from its stdout/stderr via a tolerant regex, broadcasts `oauth:device-code` and opens the browser (after a `https://`/`http://` scheme check — the URL comes from parsing subprocess output, not a URL mypa built itself, so it gets the same guard `system:open-external` already applies to renderer-supplied URLs), then resolves on process exit 0 (recording `device_login_at[entryId]` in config) or rejects on failure/15-min timeout. The spawned child is tracked in a module-level set; new export `killActiveDeviceLogins()` terminates any still running and is called from `index.ts`'s `cleanupAndExit` (alongside `disconnectAllServers`) so a login started but abandoned mid-flow can't outlive the app on quit. New `oauth:start-device-login` IPC handler resolves the command from `MCP_CATALOG` by entry id. `mcp.ts` pins `MS365_MCP_TOKEN_CACHE_PATH` to `~/.mypa/ms365-token-cache.json` for the `outlook` server (mirroring the Slack cache-file pattern) so the login process and the connected server share one token cache. `EnvField` gains `optional?: boolean` — the outlook entry's `MS365_MCP_CLIENT_ID`/`MS365_MCP_TENANT_ID` fields use it for the (rarely-needed) custom-Azure-app override. `ServerCatalogPicker` adds a `device_code` UI branch: the optional advanced fields render *above* the "Connect to <name>" button (so an org that needs a custom app sees the fields before its first, otherwise-doomed sign-in attempt) and are disabled once sign-in succeeds (previously they stayed editable post-login, which could silently save a server config against a different Azure app/tenant than the one actually signed into); a device-code display card (with a copy-to-clipboard button, matching the existing Slack-manifest copy pattern) shows the code with a manual "Open sign-in page" fallback; a connected state closes the branch — structurally parallel to the existing `oauth`/PKCE branch but with no token ever handled by the renderer. `OAuthProvider`, `oauth_apps`, and `oauth_connected_at` are untouched — Outlook doesn't use the PKCE machinery at all.

- 2026-07-23 — **Slack: inject cache-file env vars, give Slack tool calls a real longer timeout (`mcp.ts`).** `slack-mcp-server` needs `SLACK_MCP_USERS_CACHE`/`SLACK_MCP_CHANNELS_CACHE` to resolve names — without them `channels_list` is documented upstream as non-functional, and with an `xoxp` token `conversations_unreads` falls back to a slow one-call-per-channel path. `connectServer` now injects both cache paths (under `~/.mypa`) for the `slack` server when not already set in its config, and `callToolTimed` now resolves its timeout from a per-server override map instead of a flat 30 s — Slack gets 150 s, everything else keeps the 30 s default. First attempt at the override (90 s) turned out to be a no-op in practice: it only widened the `withTimeout` race, but never passed a `timeout` to `client.callTool()` itself, so the MCP SDK's own internal 60 s default request timeout fired first regardless — confirmed live against a real enterprise Slack workspace, which surfaced `MCP error -32001: Request timed out` at ~60 s instead of our own message. Fixed by passing `{ timeout: timeoutMs }` as `client.callTool()`'s third argument so the override actually reaches the SDK's own timer, not just our wrapper's. Fixes a routine that was reliably timing out on every run; see [services.md](services.md#changelog) for the full trace and [claude-integration.md](claude-integration.md#changelog) for the accompanying routine-agent fail-fast fix.

- 2026-07-22 — **GitHub switched from OAuth device flow to PAT-only (`mcp-catalog.ts`, `oauth.ts`, `ServerCatalogPicker.tsx`, `Settings.tsx`, `ipc-handlers.ts`, `preload/index.ts`, `types.ts`):** GitHub organizations can enforce OAuth-app access-control policies that block the device flow, so the GitHub catalog entry is now `authType: 'api_key'` with a single `requiredEnv` field (`GITHUB_PERSONAL_ACCESS_TOKEN`) carrying a detailed hint — fine-grained token first (org-admin-approved, repo-scoped, read-only), classic token as fallback (with an SSO-authorization callout) — mirroring the Slack entry's PAT-instructions pattern. The env key is unchanged, so previously configured tokens keep working. Removed the now-dead GitHub device-flow code: `startDeviceFlow`/`pollDeviceFlow` in `oauth.ts`, the `oauth:start-device`/`oauth:poll-device` IPC handlers and preload bindings, the `DeviceFlowSection` component and its state in `ServerCatalogPicker.tsx`, and the GitHub reconnect button + "OAuth App Credentials" GitHub Client ID card in `Settings.tsx` (that per-row reconnect button was gated on the generic `authType === 'oauth'` check but always called the GitHub-only device-flow API, so it was already non-functional for Notion/Linear). `OAuthProvider` narrowed to `'notion' | 'linear'` in both `types.ts` and `mcp-catalog.ts`; `AppConfig.oauth_apps`/`oauth_connected_at` drop their `github` keys. Notion/Linear's PKCE flow is untouched.

- 2026-06-27 — **Persist last connection error per server; surface unavailable servers to model (`mcp.ts`, `agent.ts`):** `mcp.ts` adds a module-level `serverErrors: Map<string, string>` that records the first line of the last connection error per server name. Cleared on any successful connect/reconnect/probe path in `connectAllServers` and `reconnectServer`; set on every failure path. `getServerStatus()` now includes `error` from the Map for disconnected (non-disabled) servers so the UI and callers have the failure reason without a separate reconnect attempt. In `agent.ts`, `streamAgentChat` calls `getServerStatus()` after building `sdkMcpServers` and appends an `IMPORTANT:` clause to `effectiveSystemPrompt` listing any configured-but-unavailable servers with their last error. This stops the model from confabulating tool results (e.g. inventing a ZodError/permission-gate narrative) when a server silently fails to connect.

- 2026-06-26 — **Eliminate MCP cold-boot in chat via in-process bridge (`mcp.ts`, `mcp-bridge.ts`, `agent.ts`):** Previously, every MCP-enabled chat turn caused the Agent SDK to cold-spawn all configured stdio MCP subprocesses (npx download + auth + listTools), which could consume the full 140 s startup budget before the first token arrived. The fix replaces cold-spawning entirely for chat turns. New `callToolRaw` export in `mcp.ts` returns the raw MCP `CallToolResult` (content blocks + `isError`, without flattening) for use by the bridge. New `src/main/services/mcp-bridge.ts` exports `buildBridgedMcpServers()`: iterates `getServerStatus()` and, for each connected server, creates a low-level `Server` (`@modelcontextprotocol/sdk/server/index.js`) with `tools/list` served from cached tools (no upstream round-trip) and `tools/call` forwarded via `callToolRaw`. The bridge returns `{ type: 'sdk', name, instance }` objects — the Agent SDK's in-process server variant, which only calls `instance.connect(transport)` and never spawns a subprocess. In `agent.ts`, `streamAgentChat` now calls `await ensureServersConnected()` then `buildBridgedMcpServers()` instead of the previous loop that built stdio/http/sse configs from `cfg.mcp_servers`. Disconnected or disabled servers are simply absent from the map (fast, honest). The `canUseTool` write-gating and `ask_user` in-process tool are unaffected.

- 2026-06-25 — **MCP gap-closing audit:** four changes shipped together. (1) *HTTP/SSE transport:* `McpServerConfig` gains `transport?`, `url?`, and `headers?`; `mcp.ts:connectServer` branches on transport to use `StreamableHTTPClientTransport` or `SSEClientTransport` from the MCP SDK instead of always spawning a subprocess; `agent.ts:sdkMcpServers` emits `type:'http'`/`'sse'` entries for URL servers; `claude-import.ts` marks http/sse servers as `supported:true`. `ServerCatalogPicker` adds a "Custom server (URL)" phase D with name / URL / transport / optional auth-header inputs. (2) *Enable/disable toggle:* `McpServerConfig` gains `enabled?: boolean` (default true); `connectAllServers` skips and disconnects disabled servers; `getServerStatus` returns `disabled: true`; `SetupHealthServer` gains `disabled` field and skips credential validation for disabled servers; Settings UI adds a Power icon Enable/Disable button per row with opacity dimming. (3) *Tool inspector:* Settings server rows are expandable (chevron on tool count) to show per-tool name, description, and a compact `inputSchema` parameter grid (param name / type / required badge). No new IPC needed — data already arrives in `McpServerStatus.tools`. (4) *Correctness hygiene:* `callTool` now checks `result.isError` and throws on server-reported tool errors instead of returning error payloads as success strings. Dead CLI-era exports `getKnownServerTools()` and `lastKnownTools` removed from `mcp.ts` (no external callers; were vestigial from the pre-SDK `--allowedTools` path).

- 2026-06-22 — **Agent SDK migration — MCP wiring changed:** MCP servers are now passed via `options.mcpServers` in the SDK query (not via a `--mcp-config` temp file). The `--allowedTools` CLI flag is replaced by the `canUseTool` SDK callback in `agent.ts` (read-only prefix auto-allow; write tools await user approval via `chat:tool-approval-request`). A new in-process `ask_user` MCP server (`mypa_builtin`) is registered alongside the user's configured servers for every chat stream.

- 2026-06-17 — **Fix "Test connection" false-negative + stderr diagnostics:** `mcp.ts` — `reconnectServer` now probes the live client with `listTools` when the server is already connected (non-destructive); only falls back to a full `connectServer` call when the server is not in the Map or the probe fails. This fixes the symptom where clicking "Test connection" on a healthy Slack server reported `connect slack timed out after 30s` because the old implementation always called `disconnectServer` first, killing the working subprocess. Additionally, `connectServer` now uses `stderr: 'pipe'` on the `StdioClientTransport` with a re-emitting line listener (`[mcp:<name>]` prefix) and a 30-line ring buffer; genuine timeouts append the last 5 buffered stderr lines to the error returned to the UI.

- 2026-06-16 — **Slack catalog hint: add missing channel-listing scopes.** `mcp-catalog.ts` — the `SLACK_MCP_XOXP_TOKEN` hint previously listed only `*:history` read scopes; `slack-mcp-server` also calls `getChannelsMultiType` on startup to build its channel list and fatals with "API returned zero channels and no existing cache is available" if any of `channels:read`, `groups:read`, `im:read`, `mpim:read` are absent. Added all four to the hint, plus `users:read` (required to resolve user mentions). Also added an explicit callout that the server exits immediately if the read scopes are missing, so users know to regenerate their token after updating the Slack app.
- 2026-06-16 — **MCP connection reliability + Slack --transport fix:** `mcp-catalog.ts` — Slack `baseArgs` updated to `['-y', 'slack-mcp-server@latest', '--transport', 'stdio']`; without `--transport stdio` the server defaults to HTTP and closes the stdio pipe immediately (→ `MCP error -32000: Connection closed`). `mcp.ts` — added `runExclusive` mutex for `connectAllServers`/`reconnectServer`; added `reconnectServer(name): McpServerStatus` (live reconnect, updates the connection Map); added Slack stale-config migration in `connectAllServers` (rewrites args + env for stored entries missing `--transport`); removed ephemeral `testServer` (replaced by `reconnectServer`). IPC: `config:test-mcp-server` replaced by `config:reconnect-mcp-server(name)` + `config:reconnect-all()`. Settings UI: per-row `testing/rowError` state (concurrent tests now each show their own spinner), `syncDisplay()` for post-mutation refresh, Re-check now calls `reconnectAll` for a real probe.
- 2026-06-16 — **Filesystem MCP hardening:** `mcp-catalog.ts` — added `isPath?: boolean` to `ArgInput` interface; filesystem entry sets `isPath: true` on its allowed-directories input. `mcp.ts` — added `expandTildeArgs(cfg)` helper: for catalog entries with `isPath` argInputs, expands a leading `~` in each directory arg to `os.homedir()` before spawning; applied to `connectServer`. `ipc-handlers.ts` — added `system:pick-directory` handler (`dialog.showOpenDialog`, returns `string[]`); updated `setup:get-health` to validate path-type args (missing dirs, non-existent paths, relative paths) and return them in `SetupHealthServer.invalidArgs`. `types.ts` — `SetupHealthServer` gains `invalidArgs?: string[]`; `IpcApi.system` gains `pickDirectory(multiple?): Promise<string[]>`. `ServerCatalogPicker.tsx` — arg-input rows now show a Browse… button (`FolderOpen` icon) for `isPath` inputs; `isReady()` rejects non-empty values that are neither absolute nor tilde-prefixed. `Settings.tsx` — health display folds `invalidArgs` into issue count and per-server detail.
- 2026-06-16 — **Slack catalog migrated to `slack-mcp-server` (korotovsky):** `mcp-catalog.ts` — Slack entry replaced: package changed from the deprecated `@modelcontextprotocol/server-slack` to `slack-mcp-server`; auth changed from bot token (`SLACK_BOT_TOKEN` + `SLACK_TEAM_ID`) to a user OAuth token (`SLACK_MCP_XOXP_TOKEN`, required scopes: `channels:history search:read im:history groups:history mpim:history chat:write`). The new server exposes `conversations_search_messages` (real search, user-token-capable) and `conversations_add_message` (posting, disabled by default). Added `fixedEnv?: Record<string, string>` field to `McpCatalogEntry` interface for static env vars that are always injected without user input; the Slack entry uses it to set `SLACK_MCP_ADD_MESSAGE_TOOL=true`. `ServerCatalogPicker.tsx` — `handleAdd` merges `entry.fixedEnv` into the server config env before saving.
- 2026-06-16 — **MCP call timeouts:** `mcp.ts` — added `withTimeout<T>(promise, ms, label)` helper (Promise.race with a reject-on-expiry timer). Applied to `client.connect(transport)` and `client.listTools()` in `connectServer` (30 s each), and to `server.client.callTool()` in `callTool` (30 s). A hung MCP server subprocess now unblocks the `connectAllServers` startup loop and the onboarding Auto-fill identity button after 30 s rather than hanging forever.
- 2026-06-08 — Jira catalog entry switched from `mcp-atlassian` (Cloud-only, npx) to `sooperset/mcp-atlassian` (Server/DC support, uvx); env vars changed from `ATLASSIAN_BASE_URL`/`ATLASSIAN_EMAIL`/`ATLASSIAN_API_TOKEN` to `JIRA_URL`/`JIRA_PERSONAL_TOKEN`
- 2026-06-06 — initial documentation; OAuth state nonce validation added in commit cacb072
