/**
 * Minimal Stripe API client for CF Workers (no stripe-node dep needed).
 * Only implements the endpoints PAS actually uses.
 */

export interface StripeCheckoutSession {
  id: string;
  url: string;
}

export interface StripeBillingPortalSession {
  url: string;
}

export class Stripe {
  constructor(private readonly secretKey: string) {}

  async createCheckoutSession(params: {
    customer: string;
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    metadata?: Record<string, string>;
  }): Promise<StripeCheckoutSession> {
    const body = new URLSearchParams();
    body.set('customer', params.customer);
    body.set('mode', 'subscription');
    body.set('line_items[0][price]', params.priceId);
    body.set('line_items[0][quantity]', '1');
    body.set('success_url', params.successUrl);
    body.set('cancel_url', params.cancelUrl);
    if (params.metadata) {
      for (const [k, v] of Object.entries(params.metadata)) {
        body.set(`metadata[${k}]`, v);
      }
    }
    return this.post('/v1/checkout/sessions', body);
  }

  async createBillingPortalSession(params: {
    customer: string;
    returnUrl: string;
  }): Promise<StripeBillingPortalSession> {
    const body = new URLSearchParams();
    body.set('customer', params.customer);
    body.set('return_url', params.returnUrl);
    return this.post('/v1/billing_portal/sessions', body);
  }

  async createCustomer(params: { email?: string; metadata?: Record<string, string> }): Promise<{ id: string }> {
    const body = new URLSearchParams();
    if (params.email) body.set('email', params.email);
    if (params.metadata) {
      for (const [k, v] of Object.entries(params.metadata)) {
        body.set(`metadata[${k}]`, v);
      }
    }
    return this.post('/v1/customers', body);
  }

  /**
   * Create an Express Connect account for a creator. We use Express (not
   * Standard) because creators don't need a full Stripe dashboard — the
   * platform handles invoicing, refunds, disputes. They just need a place
   * for payouts to land.
   */
  async createConnectAccount(params: {
    email?: string;
    country?: string;
    metadata?: Record<string, string>;
  }): Promise<StripeAccount> {
    const body = new URLSearchParams();
    body.set('type', 'express');
    if (params.country) body.set('country', params.country);
    if (params.email) body.set('email', params.email);
    // Request the capabilities we'll actually use. `transfers` is the
    // platform-pays-the-creator path; `card_payments` is left off since
    // creators don't accept their own cards on PAS.
    body.set('capabilities[transfers][requested]', 'true');
    if (params.metadata) {
      for (const [k, v] of Object.entries(params.metadata)) {
        body.set(`metadata[${k}]`, v);
      }
    }
    return this.post('/v1/accounts', body);
  }

  /**
   * Generate an account-onboarding link the creator follows to complete
   * Stripe's hosted KYC + bank-account setup. Links expire ~5 min after
   * creation; create a fresh one every time the Console needs to redirect.
   */
  async createAccountLink(params: {
    account: string;
    refreshUrl: string;
    returnUrl: string;
    type?: 'account_onboarding' | 'account_update';
  }): Promise<{ url: string; expires_at: number }> {
    const body = new URLSearchParams();
    body.set('account', params.account);
    body.set('refresh_url', params.refreshUrl);
    body.set('return_url', params.returnUrl);
    body.set('type', params.type ?? 'account_onboarding');
    return this.post('/v1/account_links', body);
  }

  /** Get the current state of a Connect account. */
  async getAccount(accountId: string): Promise<StripeAccount> {
    return this.get(`/v1/accounts/${encodeURIComponent(accountId)}`);
  }

  /** Create a one-time payment checkout session (for balance top-ups). */
  async createPaymentCheckout(params: {
    customer: string;
    amountCents: number;
    currency: string;
    successUrl: string;
    cancelUrl: string;
    metadata?: Record<string, string>;
  }): Promise<StripeCheckoutSession> {
    const body = new URLSearchParams();
    body.set('customer', params.customer);
    body.set('mode', 'payment');
    body.set('line_items[0][price_data][currency]', params.currency);
    body.set('line_items[0][price_data][product_data][name]', 'ProAppStore Balance Top-Up');
    body.set('line_items[0][price_data][unit_amount]', String(params.amountCents));
    body.set('line_items[0][quantity]', '1');
    // Insert session_id BEFORE the hash fragment so window.location.search
    // contains it after redirect (query params inside a hash are invisible).
    const url = new URL(params.successUrl);
    url.searchParams.set('session_id', '{CHECKOUT_SESSION_ID}');
    body.set('success_url', url.toString());
    body.set('cancel_url', params.cancelUrl);
    if (params.metadata) {
      for (const [k, v] of Object.entries(params.metadata)) {
        body.set(`metadata[${k}]`, v);
      }
    }
    return this.post('/v1/checkout/sessions', body);
  }

  /** Retrieve a checkout session to verify payment status. */
  async getCheckoutSession(sessionId: string): Promise<StripeCheckoutSessionDetail> {
    return this.get(`/v1/checkout/sessions/${encodeURIComponent(sessionId)}`);
  }

  private async post<T>(path: string, body: URLSearchParams): Promise<T> {
    const response = await fetch(`https://api.stripe.com${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`${this.secretKey}:`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Stripe ${path} failed (${response.status}): ${text}`);
    }
    return (await response.json()) as T;
  }

  private async get<T>(path: string): Promise<T> {
    const response = await fetch(`https://api.stripe.com${path}`, {
      headers: { Authorization: `Basic ${btoa(`${this.secretKey}:`)}` },
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Stripe GET ${path} failed (${response.status}): ${text}`);
    }
    return (await response.json()) as T;
  }
}

/** Subset of the Stripe Checkout Session for verifying payment. */
export interface StripeCheckoutSessionDetail {
  id: string;
  payment_status: 'paid' | 'unpaid' | 'no_payment_required';
  payment_intent: string | null;
  amount_total: number | null;
  metadata: Record<string, string> | null;
}

/** Subset of the Stripe Account object we read. The full object has 50+ fields. */
export interface StripeAccount {
  id: string;
  email?: string | null;
  country?: string;
  charges_enabled?: boolean;
  payouts_enabled?: boolean;
  details_submitted?: boolean;
}

/**
 * Verify Stripe webhook signature (HMAC-SHA256).
 */
export async function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  const parts = signature.split(',').reduce(
    (acc, part) => {
      const [k, v] = part.split('=');
      if (k === 't') acc.timestamp = v!;
      if (k === 'v1') acc.signatures.push(v!);
      return acc;
    },
    { timestamp: '', signatures: [] as string[] },
  );

  if (!parts.timestamp || parts.signatures.length === 0) return false;

  // Reject events older than 5 minutes to prevent replay attacks
  const ageSeconds = Math.floor(Date.now() / 1000) - Number(parts.timestamp);
  if (ageSeconds > 300 || ageSeconds < -60) return false;

  const signedPayload = `${parts.timestamp}.${payload}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const expectedBytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
  const expected = Array.from(new Uint8Array(expectedBytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  // Constant-time comparison to prevent timing attacks
  return parts.signatures.some((sig) => {
    if (sig.length !== expected.length) return false;
    let result = 0;
    for (let i = 0; i < sig.length; i++) {
      result |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
    }
    return result === 0;
  });
}
