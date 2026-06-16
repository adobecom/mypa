export type OAuthProvider = 'github' | 'notion' | 'linear'

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
    authType: 'oauth',
    oauthProvider: 'github',
    oauthTokenEnvKey: 'GITHUB_PERSONAL_ACCESS_TOKEN',
    patLabel: 'Personal access token',
    patPlaceholder: 'ghp_…',
    patHint: 'Generate at github.com/settings/tokens — grant repo and read:user scopes.'
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
    baseArgs: ['-y', 'slack-mcp-server'],
    requiredEnv: [
      {
        key: 'SLACK_MCP_XOXP_TOKEN',
        label: 'User OAuth token',
        placeholder: 'xoxp-...',
        hint: 'Go to api.slack.com/apps, create an app, and add a user token with channels:history, search:read, im:history, groups:history, mpim:history, and chat:write scopes.',
        secret: true
      }
    ],
    // Enables the conversations_add_message tool (off by default in the server).
    fixedEnv: { SLACK_MCP_ADD_MESSAGE_TOOL: 'true' },
    authType: 'api_key'
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
