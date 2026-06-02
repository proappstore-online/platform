export type Env = {
  // vars (wrangler.toml [vars])
  CF_ACCOUNT_ID: string;
  PAS_ZONE_ID: string;
  PUBLISHERS_ORG: string;
  APPS_DOMAIN_BASE: string;

  // secrets (wrangler secret put)
  CF_API_TOKEN: string;
  GITHUB_TOKEN: string;
  /** Shared with FAS auth flow — HS256 key used to mint + verify
   *  Bearer session tokens. Required for /api/publish-app auth. */
  SESSION_SIGNING_KEY: string;
  /** Shared secret for internal service-to-service calls (e.g. the agent-teams
   *  Worker calling /api/agent-deploy). Mirrors INTERNAL_TOKEN on agent-teams +
   *  proappstore-api. Set via `wrangler secret put INTERNAL_TOKEN`. */
  INTERNAL_TOKEN?: string;
};
