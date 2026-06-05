// OAuth client IDs for each provider.
// Register your own OAuth apps and replace the placeholder values:
//   GitHub:  github.com/settings/developers → New OAuth App
//            Callback URL: mypa://oauth/callback
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
    clientId: 'Ov23li3sHf5nDQk1ygk3'
    // GitHub Device Flow does not require a client secret
  },
  notion: {
    clientId: 'YOUR_NOTION_CLIENT_ID',
    clientSecret: 'YOUR_NOTION_CLIENT_SECRET'
  },
  linear: {
    clientId: 'YOUR_LINEAR_CLIENT_ID',
    clientSecret: 'YOUR_LINEAR_CLIENT_SECRET'
  }
}
