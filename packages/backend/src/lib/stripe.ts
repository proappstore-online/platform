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

  return parts.signatures.includes(expected);
}
