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
| `connectAllServers()` | Called at startup and on every `config:update` — iterates `config.mcp_servers`, connects all; serialized via mutex |
| `reconnectServer(name)` | Test or restore one named server under the mutex; returns `McpServerStatus`. When already connected, probes the live client with `listTools` (non-destructive); falls back to a full reconnect only when the server is not in the Map or the probe fails. This is the "Test connection" IPC action — the UI dot always reflects the actual live state. |
| `disconnectAllServers()` | Called at shutdown |
| `callTool(server, tool, params)` | Call a tool on a connected server; throws if server not found |
| `getServerStatus()` | Return `McpServerStatus[]` from the in-memory Map (no reconnect) |

**Concurrency:** a module-level `connectQueue` promise chain serializes `connectAllServers()` and `reconnectServer()`. Two near-simultaneous `config:update` calls (e.g. rapid saves or OAuth reconnect overlapping a save) cannot race and destroy each other's live connections.

**Stderr capture:** `connectServer` passes `stderr: 'pipe'` to the `StdioClientTransport`. A `data` listener re-emits each line to `process.stderr` with a `[mcp:<name>]` prefix (matching the visibility that `'inherit'` previously provided) and keeps a bounded 30-line ring buffer. When a `connect` or `listTools` timeout fires, the last 5 buffered lines are appended to the error message so the user sees what the server was doing before it stalled.

**Backward compat:**
- GitHub: if a server's env contains `GITHUB_TOKEN` but not `GITHUB_PERSONAL_ACCESS_TOKEN`, the value is copied under the new key automatically.
- Slack: if a stored slack server's `args` do not include `--transport`, `connectAllServers` rewrites the entry to `['-y', 'slack-mcp-server@latest', '--transport', 'stdio']`, preserves `SLACK_MCP_XOXP_TOKEN` if present, and injects `SLACK_MCP_ADD_MESSAGE_TOOL=true`. This auto-migrates entries created before the `--transport stdio` requirement was added without requiring a manual re-add.

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

`SetupHealth.servers[]` (from `setup.getHealth()`) reports per-server health:

| Field | Description |
|---|---|
| `connected` | Whether the server process is currently connected |
| `missingEnvKeys` | Required env vars not yet configured (empty array if all present) |
| `invalidArgs` | Path-type arg problems: missing dirs, non-existent paths, relative paths (undefined if clean) |
| `oauthProvider` | Which OAuth provider the server uses (if any) |
| `oauthConnectedAt` | ISO timestamp of last successful auth |
| `oauthStaleDays` | Days since last auth (if stale, show re-auth prompt) |

## Changelog

- 2026-06-17 — **Fix "Test connection" false-negative + stderr diagnostics:** `mcp.ts` — `reconnectServer` now probes the live client with `listTools` when the server is already connected (non-destructive); only falls back to a full `connectServer` call when the server is not in the Map or the probe fails. This fixes the symptom where clicking "Test connection" on a healthy Slack server reported `connect slack timed out after 30s` because the old implementation always called `disconnectServer` first, killing the working subprocess. Additionally, `connectServer` now uses `stderr: 'pipe'` on the `StdioClientTransport` with a re-emitting line listener (`[mcp:<name>]` prefix) and a 30-line ring buffer; genuine timeouts append the last 5 buffered stderr lines to the error returned to the UI.

- 2026-06-16 — **Slack catalog hint: add missing channel-listing scopes.** `mcp-catalog.ts` — the `SLACK_MCP_XOXP_TOKEN` hint previously listed only `*:history` read scopes; `slack-mcp-server` also calls `getChannelsMultiType` on startup to build its channel list and fatals with "API returned zero channels and no existing cache is available" if any of `channels:read`, `groups:read`, `im:read`, `mpim:read` are absent. Added all four to the hint, plus `users:read` (required to resolve user mentions). Also added an explicit callout that the server exits immediately if the read scopes are missing, so users know to regenerate their token after updating the Slack app.
- 2026-06-16 — **MCP connection reliability + Slack --transport fix:** `mcp-catalog.ts` — Slack `baseArgs` updated to `['-y', 'slack-mcp-server@latest', '--transport', 'stdio']`; without `--transport stdio` the server defaults to HTTP and closes the stdio pipe immediately (→ `MCP error -32000: Connection closed`). `mcp.ts` — added `runExclusive` mutex for `connectAllServers`/`reconnectServer`; added `reconnectServer(name): McpServerStatus` (live reconnect, updates the connection Map); added Slack stale-config migration in `connectAllServers` (rewrites args + env for stored entries missing `--transport`); removed ephemeral `testServer` (replaced by `reconnectServer`). IPC: `config:test-mcp-server` replaced by `config:reconnect-mcp-server(name)` + `config:reconnect-all()`. Settings UI: per-row `testing/rowError` state (concurrent tests now each show their own spinner), `syncDisplay()` for post-mutation refresh, Re-check now calls `reconnectAll` for a real probe.
- 2026-06-16 — **Filesystem MCP hardening:** `mcp-catalog.ts` — added `isPath?: boolean` to `ArgInput` interface; filesystem entry sets `isPath: true` on its allowed-directories input. `mcp.ts` — added `expandTildeArgs(cfg)` helper: for catalog entries with `isPath` argInputs, expands a leading `~` in each directory arg to `os.homedir()` before spawning; applied to `connectServer`. `ipc-handlers.ts` — added `system:pick-directory` handler (`dialog.showOpenDialog`, returns `string[]`); updated `setup:get-health` to validate path-type args (missing dirs, non-existent paths, relative paths) and return them in `SetupHealthServer.invalidArgs`. `types.ts` — `SetupHealthServer` gains `invalidArgs?: string[]`; `IpcApi.system` gains `pickDirectory(multiple?): Promise<string[]>`. `ServerCatalogPicker.tsx` — arg-input rows now show a Browse… button (`FolderOpen` icon) for `isPath` inputs; `isReady()` rejects non-empty values that are neither absolute nor tilde-prefixed. `Settings.tsx` — health display folds `invalidArgs` into issue count and per-server detail.
- 2026-06-16 — **Slack catalog migrated to `slack-mcp-server` (korotovsky):** `mcp-catalog.ts` — Slack entry replaced: package changed from the deprecated `@modelcontextprotocol/server-slack` to `slack-mcp-server`; auth changed from bot token (`SLACK_BOT_TOKEN` + `SLACK_TEAM_ID`) to a user OAuth token (`SLACK_MCP_XOXP_TOKEN`, required scopes: `channels:history search:read im:history groups:history mpim:history chat:write`). The new server exposes `conversations_search_messages` (real search, user-token-capable) and `conversations_add_message` (posting, disabled by default). Added `fixedEnv?: Record<string, string>` field to `McpCatalogEntry` interface for static env vars that are always injected without user input; the Slack entry uses it to set `SLACK_MCP_ADD_MESSAGE_TOOL=true`. `ServerCatalogPicker.tsx` — `handleAdd` merges `entry.fixedEnv` into the server config env before saving.
- 2026-06-16 — **MCP call timeouts:** `mcp.ts` — added `withTimeout<T>(promise, ms, label)` helper (Promise.race with a reject-on-expiry timer). Applied to `client.connect(transport)` and `client.listTools()` in `connectServer` (30 s each), and to `server.client.callTool()` in `callTool` (30 s). A hung MCP server subprocess now unblocks the `connectAllServers` startup loop and the onboarding Auto-fill identity button after 30 s rather than hanging forever.
- 2026-06-08 — Jira catalog entry switched from `mcp-atlassian` (Cloud-only, npx) to `sooperset/mcp-atlassian` (Server/DC support, uvx); env vars changed from `ATLASSIAN_BASE_URL`/`ATLASSIAN_EMAIL`/`ATLASSIAN_API_TOKEN` to `JIRA_URL`/`JIRA_PERSONAL_TOKEN`
- 2026-06-06 — initial documentation; OAuth state nonce validation added in commit cacb072
