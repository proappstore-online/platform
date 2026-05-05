export interface ProInitOptions {
  appId: string;
  /** Defaults to https://api.proappstore.online */
  apiBase?: string;
  /**
   * Bearer token from @freeappstore/sdk. Pro builds on top of free identity —
   * the user is the same; pro just adds subscription state. Pass
   * `fas.auth.token` here once the free auth flow has signed the user in.
   */
  authToken: string | (() => string | null);
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
