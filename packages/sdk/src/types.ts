export interface ProInitOptions {
  appId: string;
  /** Defaults to https://api.freeappstore.online (free-tier backend). */
  fasApiBase?: string;
  /** Defaults to https://api.proappstore.online (pro-tier backend). */
  proApiBase?: string;
  /** Defaults to https://data-{appId}.proappstore.online (per-app data worker). */
  dataApiBase?: string;
  /** Usage telemetry options. Auto-heartbeat is on by default. */
  usage?: {
    /** Default true. Set false to disable the auto-heartbeat in this app. */
    auto?: boolean;
  };
}

export type SubscriptionStatus = 'active' | 'past_due' | 'canceled' | 'incomplete';

export interface Subscription {
  status: SubscriptionStatus;
  tier: string;
  /** Stripe price id of the active plan, or null if cancelled. */
  priceId: string | null;
  /** Unix ms — when the current billing period ends. */
  currentPeriodEnd: number;
  /** True if the user has cancelled and won't auto-renew. */
  cancelAtPeriodEnd: boolean;
}

export interface CheckoutRequest {
  priceId: string;
  /** Where to send the user after success. Must be on an allowlisted origin. */
  successUrl: string;
  /** Where to send the user if they cancel checkout. */
  cancelUrl: string;
}

export interface LicenseInfo {
  key: string;
  appId: string;
  issuedAt: number;
  expiresAt: number | null;
}
