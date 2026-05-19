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
