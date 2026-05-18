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
