export interface Env {
  DB: D1Database;
  /** Shared R2 bucket for file storage. Files keyed as {appId}/{userId}/{path}. */
  STORAGE: R2Bucket;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  SESSION_SIGNING_KEY: string;
  /** FAS API for verifying auth tokens (user identity lives on free side). */
  FAS_API_BASE: string;
  /** CF credentials for provisioning (D1, Pages, Workers). */
  CF_API_TOKEN: string;
  CF_ACCOUNT_ID: string;
  /**
   * Service binding to the FAS admin Worker (`freeappstore-admin`). PAS
   * delegates the cross-store provisioning steps (GitHub repo, CF Pages,
   * DNS, custom domain, storefront registry) to FAS admin via this binding;
   * the D1 + data-worker steps stay local. See ADR 003 (one control plane).
   *
   * Service-binding fetches bypass CF Access entirely — no JWT needed.
   * Optional so the Worker boots locally without binding, in which case
   * /v1/provision falls back to D1+worker only and returns a 'skip' step
   * for everything else.
   */
  ADMIN?: Fetcher;
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
