// OAuth client credentials — never hardcode values here.
// Set the corresponding environment variables in .env (local dev)
// or as repository/CI secrets (GitHub Actions).
//
// Each provider requires its own OAuth app registration:
//   GitHub:  github.com/settings/developers → New OAuth App
//            Callback URL: mypa://oauth/callback
//            Device Flow does not require a client secret.
//   Notion:  notion.com/my-integrations → New integration (public)
//            Redirect URI: mypa://oauth/callback
//   Linear:  linear.app/settings/api → New OAuth application
//            Callback URL: mypa://oauth/callback

export interface OAuthClientConfig {
  clientId: string
  clientSecret?: string  // required for Notion & Linear token exchange
}

export const OAUTH_CLIENTS: Record<string, OAuthClientConfig> = {
  github: {
    clientId: process.env.GITHUB_CLIENT_ID ?? ''
  },
  notion: {
    clientId: process.env.NOTION_CLIENT_ID ?? '',
    clientSecret: process.env.NOTION_CLIENT_SECRET
  },
  linear: {
    clientId: process.env.LINEAR_CLIENT_ID ?? '',
    clientSecret: process.env.LINEAR_CLIENT_SECRET
  }
}
