export interface ProInitOptions {
  appId: string;
  /**
   * Browser auth/session transport.
   *
   * - legacy-bearer: OAuth returns a bearer token to JS and the SDK caches it
   *   under the PAS-owned pas:session key when storage is available.
   * - platform-cookie: PAS-hosted apps use same-origin /.pas/auth/* routes and
   *   a host-only HttpOnly cookie. Browser JS never receives the bearer token.
   *
   * Defaults to legacy-bearer for backwards compatibility until all SDK
   * primitives support the platform-cookie mediation path.
   */
  authMode?: 'legacy-bearer' | 'platform-cookie';
  /** Defaults to https://api.proappstore.online. */
  proApiBase?: string;
  /** Defaults to https://data-{appId}.proappstore.online, or same-origin /.pas/data in platform-cookie mode. */
  dataApiBase?: string;
  /** Usage telemetry options. Auto-heartbeat is on by default. */
  usage?: {
    /** Default true. Set false to disable the auto-heartbeat in this app. */
    auto?: boolean;
  };
  /**
   * Runtime error capture (`app.logs`). On by default: `window.onerror` and
   * `unhandledrejection` are recorded so a user-visible failure leaves a platform
   * record, readable by the app owner in the console.
   *
   * Independent of `usage` above — that measures engagement, this records faults.
   */
  monitoring?: {
    /** Default true. Set false to disable auto-capture and the flush timer. */
    auto?: boolean;
    /** Build metadata attached to every entry (commit sha, version, built-at). */
    build?: Record<string, unknown>;
    /** Minimum level sent. Default 'info', so `app.logs.debug()` is dropped. */
    level?: 'debug' | 'info' | 'warn' | 'error';
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

export interface SubscriptionPricing {
  proMonthly: {
    priceId: string;
    currency: string;
    dollars: number;
  } | null;
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
