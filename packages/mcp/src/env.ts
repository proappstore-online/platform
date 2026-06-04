export interface Env {
  API_BASE: string;
  /** Agent Teams API base (the autonomous build loop). e.g. https://agents.proappstore.online */
  AGENTS_BASE: string;
  GITHUB_ORG: string;
  GITHUB_TOKEN: string;
  /** Shared secret for service-to-service calls to the agents Worker. */
  INTERNAL_TOKEN?: string;
  /** HMAC key for session verification + OAuth. */
  SESSION_SIGNING_KEY?: string;
  /** Workers KV namespace for OAuth 2.1 state. */
  OAUTH_KV?: KVNamespace;
  /** FAS auth start URL for OAuth flow. */
  FAS_AUTH_START?: string;
}
