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
    oauthTokenEnvKey: 'GITHUB_PERSONAL_ACCESS_TOKEN'
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
        multiple: true
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
    description: 'Read and send messages in Slack workspaces',
    category: 'Communication',
    command: 'npx',
    baseArgs: ['-y', '@modelcontextprotocol/server-slack'],
    requiredEnv: [
      {
        key: 'SLACK_BOT_TOKEN',
        label: 'Bot token',
        placeholder: 'xoxb-...',
        hint: 'Create a Slack app and install it to your workspace.',
        secret: true
      },
      {
        key: 'SLACK_TEAM_ID',
        label: 'Team ID',
        placeholder: 'T01234ABCDE',
        hint: 'Found in your workspace URL or admin settings.'
      }
    ],
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
    oauthTokenEnvKey: 'NOTION_API_KEY'
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
    oauthTokenEnvKey: 'LINEAR_API_KEY'
  },
  {
    id: 'jira',
    name: 'Jira',
    description: 'Read and update Jira issues, sprints, and projects',
    category: 'Productivity',
    command: 'npx',
    baseArgs: ['-y', '--package', 'jsdom', '--package', 'mcp-atlassian', 'mcp-atlassian'],
    authType: 'api_key',
    requiredEnv: [
      {
        key: 'ATLASSIAN_BASE_URL',
        label: 'Jira site URL',
        placeholder: 'https://yourorg.atlassian.net',
        secret: false
      },
      {
        key: 'ATLASSIAN_EMAIL',
        label: 'Atlassian email',
        placeholder: 'you@example.com',
        secret: false
      },
      {
        key: 'ATLASSIAN_API_TOKEN',
        label: 'API token',
        placeholder: 'Paste your Atlassian API token',
        hint: 'Generate at id.atlassian.com/manage-profile/security/api-tokens',
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
