import type { ProvisionParams } from "./publish.js";

export type Env = {
  // vars (wrangler.toml [vars])
  CF_ACCOUNT_ID: string;
  PAS_ZONE_ID: string;
  PUBLISHERS_ORG: string;
  APPS_DOMAIN_BASE: string;

  /** D1 database — the platform's shared D1 (routes table for host Worker). */
  DB: D1Database;

  /** Cloudflare Workflows binding — durable publish provisioning (spike).
   *  See ProvisionWorkflow in publish.ts and the [[workflows]] block in
   *  wrangler.toml. */
  PROVISION_WORKFLOW: Workflow<ProvisionParams>;

  // secrets (wrangler secret put)
  CF_API_TOKEN: string;
  GITHUB_TOKEN: string;
  /** HS256 key used to VERIFY Bearer session tokens (see auth.ts). Must equal
   *  the backend's SESSION_SIGNING_KEY: since #142 this Worker mints nothing,
   *  so every accepted session is one the backend signed. Set by hand
   *  (`wrangler secret put`), not by deploy-admin.yml. Required for
   *  /api/publish-app auth. */
  SESSION_SIGNING_KEY: string;
  /** Shared secret for internal service-to-service calls (e.g. the agent-teams
   *  Worker calling /api/agent-deploy). Mirrors INTERNAL_TOKEN on agent-teams +
   *  proappstore-api. Set via `wrangler secret put INTERNAL_TOKEN`. */
  INTERNAL_TOKEN?: string;
  /** Cloudflare Turnstile (#26) on browser-driven publishes (/api/publish-app
   *  called with an Origin header, i.e. from the console). Public widget site
   *  key (var) + siteverify secret (secret); enforced only when BOTH are set.
   *  CLI publishes send no Origin and stay on session + provision guard. */
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
};
