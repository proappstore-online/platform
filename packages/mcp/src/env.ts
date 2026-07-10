export interface Env {
  API_BASE: string;
  /** Agent Teams API base (the autonomous build loop). e.g. https://agents.proappstore.online */
  AGENTS_BASE: string;
  /** Service bindings to sibling Workers. Same-zone subrequests bypass
   *  route-mapped Workers, so all api/agents/admin/host calls must go
   *  through these instead of plain fetch(). */
  API: Fetcher;
  AGENTS: Fetcher;
  ADMIN: Fetcher;
  HOST: Fetcher;
  GITHUB_ORG: string;
  GITHUB_TOKEN: string;
  /** Shared secret for service-to-service calls to the agents Worker. */
  INTERNAL_TOKEN?: string;
  /** HMAC key for session verification + OAuth. */
  SESSION_SIGNING_KEY?: string;
  /** Workers KV namespace for OAuth 2.1 state + MCP audit log. */
  OAUTH_KV?: KVNamespace;
  /** Set to "1" to block all mutating MCP tools (server-wide read-only mode). */
  MCP_READ_ONLY?: string;
  /** Auth start URL for OAuth flow (PAS-owned). */
  AUTH_START?: string;
  /** R2 deploy secrets — set on new repos so the deploy workflow can upload to R2. */
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_ACCOUNT_ID?: string;
}
