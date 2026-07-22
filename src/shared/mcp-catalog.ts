export type OAuthProvider = 'notion' | 'linear'

export interface EnvField {
  key: string
  label: string
  placeholder?: string
  hint?: string
  secret?: boolean
}

export interface ArgInput {
  label: string
  placeholder?: string
  hint?: string
  multiple?: boolean
  /** When true, values are filesystem directory paths. The UI shows a Browse button
   *  and the main process expands leading ~ before spawning the server. */
  isPath?: boolean
}

export interface McpCatalogEntry {
  id: string
  name: string
  description: string
  category: 'Development' | 'Communication' | 'Productivity' | 'Data' | 'AI'
  command: string
  baseArgs: string[]
  argInputs?: ArgInput[]
  authType: 'oauth' | 'api_key' | 'none'
  oauthProvider?: OAuthProvider
  oauthTokenEnvKey?: string
  requiredEnv?: EnvField[]
  /**
   * Static env vars injected automatically — not shown to the user.
   * Merged into the server config alongside user-supplied requiredEnv values.
   */
  fixedEnv?: Record<string, string>
  /** Optional PAT alternative for oauth entries */
  patLabel?: string
  patPlaceholder?: string
  patHint?: string
  /**
   * Slack app manifest (or similar provider manifest) that the user can
   * copy-paste into the provider's app-creation flow to pre-configure all
   * required permissions in one step.
   */
  appManifest?: Record<string, unknown>
}

export const MCP_CATALOG: McpCatalogEntry[] = [
  // ─── Development ────────────────────────────────────────────────────────────
  {
    id: 'github',
    name: 'GitHub',
    description: 'Read repos, issues, pull requests, and files',
    category: 'Development',
    command: 'npx',
    baseArgs: ['-y', '@modelcontextprotocol/server-github'],
    requiredEnv: [
      {
        key: 'GITHUB_PERSONAL_ACCESS_TOKEN',
        label: 'Personal access token',
        placeholder: 'github_pat_… or ghp_…',
        hint: 'Create a token at github.com/settings/tokens. Recommended: a fine-grained token — Generate new token → select the repositories mypa should see → under Repository permissions grant Read-only access to Contents, Metadata, Issues, and Pull requests. Alternatively use a classic token with the repo and read:user scopes. If your organization enforces OAuth/SSO policies, a fine-grained token must be approved by an org admin, and a classic token must be authorized for SSO (click "Configure SSO" next to the token after creating it).',
        secret: true
      }
    ],
    authType: 'api_key'
  },
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Read and write files in specified directories',
    category: 'Development',
    command: 'npx',
    baseArgs: ['-y', '@modelcontextprotocol/server-filesystem'],
    argInputs: [
      {
        label: 'Allowed directories',
        placeholder: '/Users/you/projects',
        hint: 'One directory per line. The server can only access these paths.',
        multiple: true,
        isPath: true
      }
    ],
    authType: 'none'
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    description: 'Query and inspect a PostgreSQL database',
    category: 'Data',
    command: 'npx',
    baseArgs: ['-y', '@modelcontextprotocol/server-postgres'],
    requiredEnv: [
      {
        key: 'DATABASE_URL',
        label: 'Connection URL',
        placeholder: 'postgresql://user:pass@localhost/dbname',
        hint: 'Read-only access is recommended.',
        secret: true
      }
    ],
    authType: 'api_key'
  },
  // ─── Communication ──────────────────────────────────────────────────────────
  {
    id: 'slack',
    name: 'Slack',
    description: 'Read messages, DMs, and mentions; reply and send messages',
    category: 'Communication',
    command: 'npx',
    baseArgs: ['-y', 'slack-mcp-server@latest', '--transport', 'stdio'],
    requiredEnv: [
      {
        key: 'SLACK_MCP_XOXP_TOKEN',
        label: 'User OAuth token',
        placeholder: 'xoxp-...',
        hint: 'Install the app using the manifest above, then go to OAuth & Permissions and copy the User OAuth Token (xoxp-...). If your workspace blocks manifest uploads, add these user scopes manually: channels:read, channels:history, groups:read, groups:history, im:read, im:history, mpim:read, mpim:history, search:read, users:read, chat:write, files:read.',
        secret: true
      }
    ],
    // Enables the conversations_add_message tool (off by default in the server).
    fixedEnv: { SLACK_MCP_ADD_MESSAGE_TOOL: 'true' },
    authType: 'api_key',
    appManifest: {
      display_information: {
        name: 'mypa',
        description: 'Local AI assistant that reads your Slack activity to surface context and intents.',
        background_color: '#4545b0'
      },
      features: {
        bot_user: {
          display_name: 'mypa',
          always_online: false
        }
      },
      oauth_config: {
        scopes: {
          user: [
            'channels:read',
            'channels:history',
            'groups:read',
            'groups:history',
            'im:read',
            'im:history',
            'mpim:read',
            'mpim:history',
            'search:read',
            'users:read',
            'chat:write',
            'files:read'
          ],
          bot: [
            'channels:history',
            'channels:read',
            'groups:history',
            'groups:read',
            'im:history',
            'im:read',
            'mpim:history',
            'mpim:read',
            'chat:write',
            'reactions:write',
            'users:read',
            'users.profile:read',
            'files:read'
          ]
        },
        pkce_enabled: false
      },
      settings: {
        org_deploy_enabled: false,
        socket_mode_enabled: false,
        token_rotation_enabled: false,
        is_mcp_enabled: false
      }
    }
  },
  // ─── Productivity ────────────────────────────────────────────────────────────
  {
    id: 'notion',
    name: 'Notion',
    description: 'Read and write Notion pages and databases',
    category: 'Productivity',
    command: 'npx',
    baseArgs: ['-y', '@notionhq/notion-mcp-server'],
    authType: 'oauth',
    oauthProvider: 'notion',
    oauthTokenEnvKey: 'NOTION_API_KEY',
    patLabel: 'Internal integration token',
    patPlaceholder: 'secret_… or ntn_…',
    patHint: 'Create an internal integration at notion.so/my-integrations, then share your pages with it.'
  },
  {
    id: 'linear',
    name: 'Linear',
    description: 'Manage Linear issues, projects, and cycles',
    category: 'Productivity',
    command: 'npx',
    baseArgs: ['-y', 'linear-mcp-server'],
    authType: 'oauth',
    oauthProvider: 'linear',
    oauthTokenEnvKey: 'LINEAR_API_KEY',
    patLabel: 'Personal API key',
    patPlaceholder: 'lin_api_…',
    patHint: 'Generate at linear.app → Settings → API → Personal API keys.'
  },
  {
    id: 'jira',
    name: 'Jira',
    description: 'Read and update Jira issues, sprints, and projects',
    category: 'Productivity',
    command: 'uvx',
    baseArgs: ['mcp-atlassian'],
    authType: 'api_key',
    requiredEnv: [
      {
        key: 'JIRA_URL',
        label: 'Jira URL',
        placeholder: 'https://jira.corp.adobe.com',
        secret: false
      },
      {
        key: 'JIRA_PERSONAL_TOKEN',
        label: 'Personal Access Token',
        placeholder: 'Paste your Jira PAT',
        hint: 'Generate at your Jira profile → Personal Access Tokens',
        secret: true
      }
    ]
  },
  // ─── Data ────────────────────────────────────────────────────────────────────
  {
    id: 'brave-search',
    name: 'Brave Search',
    description: 'Web and local search via Brave Search API',
    category: 'Data',
    command: 'npx',
    baseArgs: ['-y', '@modelcontextprotocol/server-brave-search'],
    requiredEnv: [
      {
        key: 'BRAVE_API_KEY',
        label: 'API Key',
        placeholder: 'BSA...',
        hint: 'Get your key from brave.com/search/api.',
        secret: true
      }
    ],
    authType: 'api_key'
  },
  {
    id: 'google-maps',
    name: 'Google Maps',
    description: 'Geocoding, directions, and places search',
    category: 'Data',
    command: 'npx',
    baseArgs: ['-y', '@modelcontextprotocol/server-google-maps'],
    requiredEnv: [
      {
        key: 'GOOGLE_MAPS_API_KEY',
        label: 'API Key',
        placeholder: 'AIza...',
        hint: 'Enable Maps API in Google Cloud Console.',
        secret: true
      }
    ],
    authType: 'api_key'
  },
  // ─── AI ──────────────────────────────────────────────────────────────────────
  {
    id: 'memory',
    name: 'Memory',
    description: 'Persistent key-value memory across conversations',
    category: 'AI',
    command: 'npx',
    baseArgs: ['-y', '@modelcontextprotocol/server-memory'],
    authType: 'none'
  },
  {
    id: 'puppeteer',
    name: 'Puppeteer',
    description: 'Browser automation — screenshots, scraping, and clicks',
    category: 'AI',
    command: 'npx',
    baseArgs: ['-y', '@modelcontextprotocol/server-puppeteer'],
    authType: 'none'
  }
]

export const CATALOG_CATEGORIES = [
  'Development',
  'Communication',
  'Productivity',
  'Data',
  'AI'
] as const
