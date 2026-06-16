# MCP & OAuth

## MCP (Model Context Protocol)

mypa connects to MCP servers over stdio transport using `@modelcontextprotocol/sdk`. Each server provides tools that routines and plan actions call.

**Source files:**
- `src/main/services/mcp.ts` — client manager
- `src/main/services/claude-import.ts` — Claude Code config import
- `src/shared/mcp-catalog.ts` — built-in server catalog
- `src/shared/types.ts` — `McpServerConfig`, `McpTool`, `McpServerStatus`, `DetectedMcpServer`

---

### Server configuration (`McpServerConfig`)

```ts
interface McpServerConfig {
  name:     string
  command:  string           // executable to spawn (e.g. 'npx', 'uvx', '/path/to/bin')
  args?:    string[]
  env?:     Record<string, string>   // encrypted at rest with safeStorage
}
```

Servers are stored in `AppConfig.mcp_servers`. Env var values with an `enc:` prefix are decrypted before being passed to the subprocess (see [configuration.md](configuration.md)).

---

### MCP client manager (`mcp.ts`)

Maintains a `Map<string, Client>` of active connections keyed by server name.

| Export | Description |
|---|---|
| `connectServer(cfg)` | Spawn the server process, establish stdio transport, list available tools, cache the client |
| `disconnectServer(name)` | Gracefully close the transport, remove from cache |
| `connectAllServers()` | Called at startup — iterates `config.mcp_servers`, connects all enabled ones |
| `disconnectAllServers()` | Called at shutdown |
| `callTool(server, tool, params)` | Call a tool on a connected server; throws if server not found |
| `getServerStatus()` | Return `McpServerStatus[]` for all configured servers (connected + tool list, or error) |
| `testServer(cfg)` | Ephemeral connect → list tools → disconnect; used by Settings "Test connection" |

**Backward compat:** on connect, if a server's env contains `GITHUB_TOKEN` but not `GITHUB_PERSONAL_ACCESS_TOKEN`, the value is copied under the new key automatically.

---

### Built-in catalog (`mcp-catalog.ts`)

`src/shared/mcp-catalog.ts` exports a list of pre-configured MCP server templates users can add in one click from the Settings panel. Each entry includes the command, args template, required env keys, and an OAuth provider hint (if applicable).

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

mypa supports OAuth authentication for GitHub, Notion, and Linear to enrich routines with live data from those services.

**Source files:**
- `src/main/services/oauth.ts` — flow implementations
- `src/shared/oauth-config.ts` — provider configurations
- `src/shared/types.ts` — `OAuthProvider`, `DeviceFlowStart`, `OAuthAppCredential`

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

### GitHub — device flow

Used when the user doesn't want to register a GitHub OAuth app (no redirect URI required).

```
startDevice() → { userCode, verificationUri, deviceCode, interval }
```

The user visits `verificationUri` and enters `userCode`. The caller polls:

```
pollDevice(deviceCode) → accessToken
```

Polling uses `interval` (seconds) returned by GitHub's device authorization endpoint. Returns the access token when the user completes authorization.

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

### Connection status

`SetupHealth.servers[]` (from `setup.getHealth()`) reports per-server OAuth health:

| Field | Description |
|---|---|
| `oauthProvider` | Which OAuth provider the server uses (if any) |
| `oauthConnectedAt` | ISO timestamp of last successful auth |
| `oauthStaleDays` | Days since last auth (if stale, show re-auth prompt) |

## Changelog

- 2026-06-16 — **Slack catalog migrated to `slack-mcp-server` (korotovsky):** `mcp-catalog.ts` — Slack entry replaced: package changed from the deprecated `@modelcontextprotocol/server-slack` to `slack-mcp-server`; auth changed from bot token (`SLACK_BOT_TOKEN` + `SLACK_TEAM_ID`) to a user OAuth token (`SLACK_MCP_XOXP_TOKEN`, required scopes: `channels:history search:read im:history groups:history mpim:history chat:write`). The new server exposes `conversations_search_messages` (real search, user-token-capable) and `conversations_add_message` (posting, disabled by default). Added `fixedEnv?: Record<string, string>` field to `McpCatalogEntry` interface for static env vars that are always injected without user input; the Slack entry uses it to set `SLACK_MCP_ADD_MESSAGE_TOOL=true`. `ServerCatalogPicker.tsx` — `handleAdd` merges `entry.fixedEnv` into the server config env before saving.
- 2026-06-16 — **MCP call timeouts:** `mcp.ts` — added `withTimeout<T>(promise, ms, label)` helper (Promise.race with a reject-on-expiry timer). Applied to `client.connect(transport)` and `client.listTools()` in `connectServer` (30 s each), and to `server.client.callTool()` in `callTool` (30 s). A hung MCP server subprocess now unblocks the `connectAllServers` startup loop and the onboarding Auto-fill identity button after 30 s rather than hanging forever.
- 2026-06-08 — Jira catalog entry switched from `mcp-atlassian` (Cloud-only, npx) to `sooperset/mcp-atlassian` (Server/DC support, uvx); env vars changed from `ATLASSIAN_BASE_URL`/`ATLASSIAN_EMAIL`/`ATLASSIAN_API_TOKEN` to `JIRA_URL`/`JIRA_PERSONAL_TOKEN`
- 2026-06-06 — initial documentation; OAuth state nonce validation added in commit cacb072
