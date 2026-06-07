# Configuration

## Runtime data location

All runtime data lives under `~/.mypa/`:

| Path | Description |
|---|---|
| `~/.mypa/config.json` | App configuration (JSON) |
| `~/.mypa/data.db` | SQLite database (WAL mode) |

The directory is created on first launch by `ensureConfigDir()` in `src/main/services/config.ts`.

---

## `config.json` shape (`AppConfig`)

Defined in `src/shared/types.ts`. Deep-merged with `DEFAULT_CONFIG` on every read — missing keys always fall back to defaults.

```jsonc
{
  "claude": {
    "model": "claude-opus-4-8"     // Claude model ID; empty = CLI default
  },
  "mcp_servers": [
    {
      "name":    "github",
      "command": "npx",
      "args":    ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "enc:..."  // encrypted at rest
      }
    }
  ],
  "preferences": {
    "widget_always_on_top": false,
    "notification_sound":   true,
    "launch_on_login":      false
  },
  "persona":             "a senior software engineer",   // optional
  "onboarding_complete": true,
  "oauth_apps": {
    "github":  { "clientId": "…", "clientSecret": "enc:…" },
    "notion":  { "clientId": "…", "clientSecret": "enc:…" },
    "linear":  { "clientId": "…", "clientSecret": "enc:…" }
  },
  "oauth_connected_at": {
    "github":  "2026-06-01T10:00:00Z",
    "notion":  null,
    "linear":  null
  },
  "ambient": {
    "enabled":          true,
    "pollIntervalMs":   300000,    // 5 minutes
    "decayHalfLifeDays": 7,
    "confidenceFloor":   0.4
  }
}
```

### Defaults (`DEFAULT_CONFIG`)

```ts
{
  claude:      { model: 'claude-opus-4-8' },
  mcp_servers: [],
  preferences: { widget_always_on_top: false, notification_sound: true, launch_on_login: false },
  onboarding_complete: false,
  ambient: { enabled: true, pollIntervalMs: 300000, decayHalfLifeDays: 7, confidenceFloor: 0.4 }
}
```

---

## Secret encryption

Implemented in `src/main/services/config.ts` using Electron's [`safeStorage`](https://www.electronjs.org/docs/latest/api/safe-storage) API (OS keychain integration).

**What is encrypted:**
- `mcp_servers[].env.*` — all env var values for MCP servers (API keys, tokens)
- `oauth_apps[provider].clientSecret` — OAuth client secrets

**Format:** encrypted values are stored as base64-encoded strings prefixed with `enc:`:
```
enc:BASE64_ENCODED_CIPHERTEXT
```

**On read:** `readConfig()` decrypts all `enc:`-prefixed values in memory before returning the config. Decrypted secrets are never written back to disk.

**Fallback:** if `safeStorage.isEncryptionAvailable()` returns false (e.g. headless CI environment), values are stored and read as plain text with a console warning.

**Double-encryption guard:** `encryptValue()` checks for the `enc:` prefix before encrypting — re-saving an already-encrypted config won't double-encrypt.

---

## Config API

`src/main/services/config.ts` exports:

| Function | Description |
|---|---|
| `readConfig()` | Read + decrypt + deep-merge with defaults |
| `writeConfig(config)` | Encrypt secrets + write |
| `updateConfig(partial)` | Deep-merge partial update, write, return updated config |
| `ensureConfigDir()` | `mkdir -p ~/.mypa/` |

The deep-merge is array-replacing (arrays are replaced, not merged item-by-item), which means `mcp_servers` is always taken as a complete list from the merged result.

---

## Electron build configuration

Defined in `package.json → build`. Built with `electron-builder`.

| Field | Value |
|---|---|
| `appId` | `com.mypa.app` |
| `productName` | `mypa` |
| Output directory | `dist/` |

### Build targets

| Platform | Format |
|---|---|
| macOS | DMG |
| Linux | AppImage + DEB |
| Windows | NSIS installer |

Code signing is disabled in the release workflow (`CSC_IDENTITY_AUTO_DISCOVERY: false`). Enable and configure signing for distribution builds.

### `mypa://` custom URL scheme

Registered in `protocols`:
```json
{ "name": "mypa", "schemes": ["mypa"] }
```

Used as the OAuth redirect URI (`mypa://oauth/callback`). The main process handles `open-url` events to receive the callback.

### Native module unpacking

`better-sqlite3` and `onnxruntime-node` (used by `@xenova/transformers`) are excluded from the ASAR archive:
```json
"asarUnpack": ["**/node_modules/better-sqlite3/**", "**/node_modules/onnxruntime-node/**"]
```

After installing or upgrading either, rebuild with:
```bash
npm run postinstall
```

---

## Preferences

Managed from the widget's Settings panel and persisted in `config.preferences`:

| Key | Default | Description |
|---|---|---|
| `widget_always_on_top` | `false` | Keep the widget popover above all other windows |
| `notification_sound` | `true` | Play a sound with OS notifications |
| `launch_on_login` | `false` | Register as a login item (macOS / Windows) |

## Changelog

- 2026-06-06 — initial documentation
