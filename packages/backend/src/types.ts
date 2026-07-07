export interface Env {
  DB: D1Database;
  /** Shared R2 bucket for file storage. Files keyed as {appId}/{userId}/{path}. */
  STORAGE: R2Bucket;
  /** Durable Object namespace for realtime rooms. */
  ROOM: DurableObjectNamespace;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  /** Stripe price ID for the $9/mo platform subscription. Read by GET /v1/pricing. */
  STRIPE_PRO_MONTHLY_PRICE_ID?: string;
  /** Signs + verifies PAS session JWTs (build-core/session-jwt). */
  SESSION_SIGNING_KEY: string;
  /** Public base URL of this API, for building OAuth callback URLs. e.g. https://api.proappstore.online */
  APP_BASE?: string;
  /** PAS OAuth app credentials — set as secrets to enable browser sign-in. */
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** CF credentials for provisioning (D1, Pages, Workers). */
  CF_API_TOKEN: string;
  CF_ACCOUNT_ID: string;
  /** Access key id of the parent `pas-apps` R2 API token. Used to mint
   *  short-lived, prefix-scoped deploy credentials (see routes/deploy.ts).
   *  NOT a secret on its own — an access key id; minting also requires
   *  CF_API_TOKEN (which must have R2 read/write). Set via:
   *    wrangler secret put R2_PARENT_ACCESS_KEY_ID */
  R2_PARENT_ACCESS_KEY_ID?: string;
  /** Proxied hostname on the SaaS zone that external custom domains CNAME to.
   *  Optional — defaults to `cname.proappstore.online`. Set when Cloudflare for
   *  SaaS is enabled. */
  CF_SAAS_CNAME_TARGET?: string;
  // ADMIN service binding (was: freeappstore-admin) removed 2026-05-28
  // per PLAN-ARCH-CLEANUP Phase 4. PAS provisioning is fully self-contained
  // in routes/provision.ts; the binding was unused.
  /** VAPID keys for Web Push notifications. */
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  /**
   * Workers AI binding — backs the app.ai SDK primitive. Set via the
   * [ai] block in wrangler.toml. Type is loose because @cloudflare/workers-types
   * exposes it as `Ai` only when ai_binding feature is enabled.
   */
  AI: {
    run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
  };
  /**
   * Twilio credentials for SMS. Optional so the Worker boots without them;
   * /sms/send returns 503 if unset. Provision via:
   *   wrangler secret put TWILIO_ACCOUNT_SID
   *   wrangler secret put TWILIO_AUTH_TOKEN
   *   wrangler secret put TWILIO_FROM_NUMBER
   */
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  /** Sender number in E.164 format, e.g. "+15551234567". */
  TWILIO_FROM_NUMBER?: string;
  /**
   * Comma-separated list of `gh:<id>` strings allowed to approve/reject
   * submissions and to list all submissions across the platform. Other
   * authenticated users see only their own submissions.
   */
  ADMIN_GITHUB_IDS?: string;
  /**
   * Optional GitHub token used by the server-side compliance check at
   * /v1/provision (raises GitHub's unauth rate limit of 60/hr to 5000/hr).
   * A fine-grained PAT with read-only "Contents" + "Metadata" permissions
   * on the storefront orgs is enough — no write scopes needed.
   *   wrangler secret put GITHUB_TOKEN
   */
  GITHUB_TOKEN?: string;
  /**
   * Shared secret the admin Worker uses to authenticate inbound calls to
   * `/v1/internal/*` (e.g. PUT analytics/cf-token after minting a CF Web
   * Analytics site for a pro app). Set via `wrangler secret put
   * INTERNAL_TOKEN` and mirror the same value on the admin Worker. Internal
   * routes 403 when the secret is unset.
   */
  INTERNAL_TOKEN?: string;
  /**
   * Workers Analytics Engine dataset binding for first-party server-side
   * visitor + custom event analytics. Powers the in-platform dashboard
   * (queryable via the SQL API at /v1/apps/:id/analytics/stats).
   */
  ANALYTICS?: AnalyticsEngineDataset;
  /**
   * CF API token with 'Account Analytics:Read' permission. Used by the
   * /stats endpoint to query Analytics Engine via the SQL API.
   */
  CF_ANALYTICS_API_TOKEN?: string;
  /** Resend API key for transactional email. If unset, /v1/email/send returns 503. */
  RESEND_API_KEY?: string;
  /** Anthropic API key for Managed Agents. If unset, /v1/agent/* returns 503. */
  ANTHROPIC_API_KEY?: string;
  /**
   * Master key-encryption-key for the proxy's envelope encryption of app
   * secrets. Base64-encoded 32-byte key. Set via `wrangler secret put APP_SECRET_KEK`.
   * Without this, proxy/secrets/allowlist endpoints return 503.
   */
  APP_SECRET_KEK?: string;
  /** Sender address for outbound emails. Defaults to "ProAppStore <noreply@proappstore.online>". */
  EMAIL_FROM?: string;
}

export interface PushSubscriptionRow {
  id: string;
  user_id: string;
  app_id: string;
  endpoint: string;
  p256dh: string;
  auth_secret: string;
  created_at: number;
}

export interface SubscriptionRow {
  user_id: string;
  stripe_customer_id: string;
  stripe_subscription_id: string | null;
  status: string;
  tier: string;
  price_id: string | null;
  current_period_end: number;
  cancel_at_period_end: number;
  created_at: number;
  updated_at: number;
}

export interface LicenseRow {
  key: string;
  app_id: string;
  user_id: string;
  issued_at: number;
  expires_at: number | null;
  revoked: number;
}

/**
 * Per-(app, user, day) usage rollup row. Mirrors the `usage_daily` table.
 * The monthly payout cron sums these to compute each creator's share of
 * the subscriber pool.
 */
export interface UsageRow {
  app_id: string;
  user_id: string;
  /** YYYY-MM-DD in UTC. */
  day: string;
  session_seconds: number;
  api_calls: number;
  /** Epoch ms of the most recent ping. */
  last_seen: number;
}

/** A pending / reviewed dev submission. Mirrors `submissions` table. */
export interface SubmissionRow {
  id: string;
  app_id: string;
  creator_id: string;
  status: 'pending' | 'approved' | 'rejected' | 'published';
  name: string;
  category: string;
  description: string;
  icon: string | null;
  icon_bg: string | null;
  /** JSON-stringified string[]. Null when not set. */
  pro_features: string | null;
  suggested_monthly_price_cents: number | null;
  repo_url: string | null;
  reviewer_id: string | null;
  rejection_reason: string | null;
  created_at: number;
  reviewed_at: number | null;
}
