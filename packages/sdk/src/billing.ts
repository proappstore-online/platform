/**
 * App billing (#509, epic #506): the products an app declared in its manifest, checkout, the signed-in user's own purchases and
 * entitlements, and Stripe's customer portal. The platform's own Pro subscription is `app.subscription`; this is for what YOUR app sells.
 *
 * Every call is the signed-in user's: they only ever see what they bought. Who may buy, and what a purchase unlocks, is decided by
 * your app's own SQL (the `authorize` action, and a JOIN on `_pas_entitlements`), never by this client.
 */

interface AuthLike {
  handleUnauthorized(): void;
  authenticatedFetch(input: string | URL, init?: RequestInit): Promise<Response>;
}

export type BillingMode = 'one_time' | 'recurring';
export type EntitlementStatus = 'active' | 'grace' | 'expired' | 'refunded' | 'canceled';

/** A product the app declared in `mcp.json`. Amounts are in the smallest currency unit (cents). */
export interface BillingProduct {
  key: string;
  name: string;
  amount: number;
  currency: string;
  taxBehavior: string;
  modes: BillingMode[];
  /** The term a purchase buys (`{ unit: 'month', count: 3 }`), or null for a one-off with no term. */
  interval: { unit: string; count: number | null } | null;
  graceDays: number;
  /** Whether a purchase names subjects: `none`, or `required` (one entitlement per subject). */
  subject: string;
}

export interface BillingCheckoutRequest {
  /** A product key from {@link BillingApi.products}. */
  product: string;
  /** The app-side ids the purchase is for (a child, a team): one entitlement each. Omit for a product with no subject. */
  subjects?: string[];
  /** Buy with auto-renew. Default is a one-off. */
  renew?: boolean;
  /** Where Stripe sends the buyer afterwards. Must be on the app's own origins. */
  successUrl: string;
  cancelUrl: string;
}

export interface BillingEntitlement {
  product: string;
  /** The subject this entitlement is for; the empty string for a product with no subject. */
  subject: string;
  status: EntitlementStatus;
  periodStart: number | null;
  /** Epoch ms the paid term ends. */
  periodEnd: number | null;
  /** Epoch ms a payment-failure grace period ends, while status is `grace`. */
  graceUntil: number | null;
  renews: boolean;
  updatedAt: number;
}

export interface BillingPurchase {
  id: string;
  product: string;
  subjects: string[];
  mode: BillingMode;
  status: 'paid' | 'canceled' | 'refunded';
  createdAt: number;
  /** What was paid, in the smallest currency unit of `currency`. */
  paid: number;
  currency: string | null;
  /** The renewal has been switched off and ends with the current term. */
  cancelAtPeriodEnd: boolean;
}

export class BillingApi {
  constructor(
    private readonly appId: string,
    private readonly apiBase: string,
    private readonly auth: AuthLike,
  ) {}

  /** The app's active products. Fails with 403 until the platform has enabled billing for the app. */
  async products(): Promise<BillingProduct[]> {
    return ((await this.json('GET', '/billing/products', 'billing.products')) as { products: BillingProduct[] }).products;
  }

  /** Starts Stripe checkout and returns its URL; send the buyer there with `location.assign(url)`. */
  async checkout(req: BillingCheckoutRequest): Promise<{ url: string; purchaseId: string }> {
    return (await this.json('POST', '/billing/checkout', 'billing.checkout', req)) as { url: string; purchaseId: string };
  }

  /**
   * The signed-in user's own entitlements; another buyer's are never returned. `subjects` narrows to those subject ids. This is for
   * showing state in the UI: enforce access in your own SQL against `_pas_entitlements`.
   */
  async entitlements(opts: { subjects?: string[] } = {}): Promise<BillingEntitlement[]> {
    const query = opts.subjects ? `?subjects=${encodeURIComponent(opts.subjects.join(','))}` : '';
    return ((await this.json('GET', `/billing/entitlements${query}`, 'billing.entitlements')) as { entitlements: BillingEntitlement[] }).entitlements;
  }

  /** The signed-in user's own purchases in this app. */
  async purchases(): Promise<BillingPurchase[]> {
    return ((await this.json('GET', '/billing/purchases', 'billing.purchases')) as { purchases: BillingPurchase[] }).purchases;
  }

  /** A Stripe customer-portal URL for the signed-in user (cancel a renewal, download receipts). `returnUrl` must be on the app's own origins. */
  async portal(returnUrl: string): Promise<{ url: string }> {
    return (await this.json('POST', '/billing/portal', 'billing.portal', { returnUrl })) as { url: string };
  }

  private async json(method: string, path: string, name: string, body?: unknown): Promise<unknown> {
    const init: RequestInit = { method, ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) };
    const response = await this.auth.authenticatedFetch(new URL(`/v1/apps/${encodeURIComponent(this.appId)}${path}`, this.apiBase), init);
    if (response.status === 401) {
      this.auth.handleUnauthorized();
      throw new Error('Not signed in.');
    }
    if (!response.ok) {
      const detail = await response.json().then((b: { error?: string }) => b.error, () => undefined);
      throw new Error(`${name} failed: ${response.status}${detail ? ` ${detail}` : ''}`);
    }
    return response.json();
  }
}
