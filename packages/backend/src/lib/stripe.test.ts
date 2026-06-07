import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Stripe, verifyWebhookSignature } from './stripe.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function mockOk(data: unknown) {
  mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(data) } as Response);
}

function mockFail(status: number, body: string) {
  mockFetch.mockResolvedValueOnce({ ok: false, status, text: () => Promise.resolve(body) } as Response);
}

describe('Stripe client', () => {
  const stripe = new Stripe('sk_test_123');

  beforeEach(() => mockFetch.mockReset());

  it('createCheckoutSession sends correct params', async () => {
    mockOk({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' });
    const session = await stripe.createCheckoutSession({
      customer: 'cus_1',
      priceId: 'price_1',
      successUrl: 'https://app.example.com/success',
      cancelUrl: 'https://app.example.com/cancel',
      metadata: { appId: 'test-app' },
    });
    expect(session.id).toBe('cs_1');
    expect(session.url).toContain('checkout.stripe.com');

    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(opts.method).toBe('POST');
    const body = opts.body as string;
    expect(body).toContain('customer=cus_1');
    expect(body).toContain('mode=subscription');
    expect(body).toContain(encodeURIComponent('price_1'));
    expect(body).toContain('metadata%5BappId%5D=test-app');
  });

  it('createBillingPortalSession sends correct params', async () => {
    mockOk({ url: 'https://billing.stripe.com/session/bps_1' });
    const portal = await stripe.createBillingPortalSession({
      customer: 'cus_1',
      returnUrl: 'https://app.example.com',
    });
    expect(portal.url).toContain('billing.stripe.com');

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.stripe.com/v1/billing_portal/sessions');
  });

  it('createCustomer with email and metadata', async () => {
    mockOk({ id: 'cus_new' });
    const customer = await stripe.createCustomer({
      email: 'alice@example.com',
      metadata: { userId: 'u-1' },
    });
    expect(customer.id).toBe('cus_new');

    const body = (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string;
    expect(body).toContain('email=alice%40example.com');
    expect(body).toContain('metadata%5BuserId%5D=u-1');
  });

  it('createConnectAccount requests express + transfers capability', async () => {
    mockOk({ id: 'acct_1' });
    await stripe.createConnectAccount({ email: 'dev@example.com', country: 'US' });

    const body = (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string;
    expect(body).toContain('type=express');
    expect(body).toContain('country=US');
    expect(body).toContain(encodeURIComponent('capabilities[transfers][requested]') + '=true');
  });

  it('createAccountLink sends correct params', async () => {
    mockOk({ url: 'https://connect.stripe.com/setup/e/1', expires_at: 1700000000 });
    const link = await stripe.createAccountLink({
      account: 'acct_1',
      refreshUrl: 'https://app.example.com/refresh',
      returnUrl: 'https://app.example.com/return',
    });
    expect(link.url).toContain('connect.stripe.com');

    const body = (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string;
    expect(body).toContain('account=acct_1');
    expect(body).toContain('type=account_onboarding');
  });

  it('getAccount calls GET with auth header', async () => {
    mockOk({ id: 'acct_1', charges_enabled: true, payouts_enabled: true });
    const account = await stripe.getAccount('acct_1');
    expect(account.id).toBe('acct_1');
    expect(account.charges_enabled).toBe(true);

    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.stripe.com/v1/accounts/acct_1');
    expect(opts.method).toBeUndefined(); // GET is default
    expect((opts.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
  });

  it('createPaymentCheckout sets one-time payment mode', async () => {
    mockOk({ id: 'cs_pay', url: 'https://checkout.stripe.com/c/pay/cs_pay' });
    await stripe.createPaymentCheckout({
      customer: 'cus_1',
      amountCents: 2500,
      currency: 'usd',
      successUrl: 'https://app.example.com/success',
      cancelUrl: 'https://app.example.com/cancel',
    });

    const body = (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string;
    expect(body).toContain('mode=payment');
    expect(body).toContain('2500');
    expect(body).toContain('Balance+Top-Up');
  });

  it('getCheckoutSession retrieves payment verification data', async () => {
    mockOk({ id: 'cs_1', payment_status: 'paid', payment_intent: 'pi_1', amount_total: 900 });
    const session = await stripe.getCheckoutSession('cs_1');
    expect(session.payment_status).toBe('paid');
    expect(session.amount_total).toBe(900);

    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.stripe.com/v1/checkout/sessions/cs_1');
    expect(opts.method).toBeUndefined(); // GET
  });

  it('createTransfer sends amount + destination', async () => {
    mockOk({ id: 'tr_1', amount: 1000, currency: 'usd', destination: 'acct_1' });
    const transfer = await stripe.createTransfer({
      amountCents: 1000,
      currency: 'usd',
      destination: 'acct_1',
      description: 'June payout',
    });
    expect(transfer.id).toBe('tr_1');
    expect(transfer.amount).toBe(1000);

    const body = (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string;
    expect(body).toContain('amount=1000');
    expect(body).toContain('destination=acct_1');
    expect(body).toContain('description=June+payout');
  });

  it('uses Basic auth with secret key', async () => {
    mockOk({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' });
    await stripe.createCheckoutSession({
      customer: 'cus_1', priceId: 'price_1',
      successUrl: 'https://x.com/ok', cancelUrl: 'https://x.com/no',
    });

    const headers = (mockFetch.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${btoa('sk_test_123:')}`);
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
  });

  it('throws on non-ok response with status and body', async () => {
    mockFail(402, '{"error":{"message":"Card declined"}}');
    await expect(
      stripe.createCheckoutSession({
        customer: 'cus_1', priceId: 'price_1',
        successUrl: 'https://x.com/ok', cancelUrl: 'https://x.com/no',
      })
    ).rejects.toThrow(/402.*Card declined/);
  });
});

describe('verifyWebhookSignature', () => {
  async function sign(payload: string, secret: string, timestamp: number): Promise<string> {
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${payload}`));
    const hex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
    return `t=${timestamp},v1=${hex}`;
  }

  it('accepts a valid signature', async () => {
    const payload = '{"type":"checkout.session.completed"}';
    const secret = 'whsec_test123';
    const ts = Math.floor(Date.now() / 1000);
    const header = await sign(payload, secret, ts);
    expect(await verifyWebhookSignature(payload, header, secret)).toBe(true);
  });

  it('rejects a wrong secret', async () => {
    const payload = '{"type":"checkout.session.completed"}';
    const ts = Math.floor(Date.now() / 1000);
    const header = await sign(payload, 'whsec_correct', ts);
    expect(await verifyWebhookSignature(payload, header, 'whsec_wrong')).toBe(false);
  });

  it('rejects a tampered payload', async () => {
    const secret = 'whsec_test';
    const ts = Math.floor(Date.now() / 1000);
    const header = await sign('{"original": true}', secret, ts);
    expect(await verifyWebhookSignature('{"tampered": true}', header, secret)).toBe(false);
  });

  it('rejects events older than 5 minutes (replay protection)', async () => {
    const payload = '{"type":"test"}';
    const secret = 'whsec_test';
    const staleTs = Math.floor(Date.now() / 1000) - 600; // 10 min ago
    const header = await sign(payload, secret, staleTs);
    expect(await verifyWebhookSignature(payload, header, secret)).toBe(false);
  });

  it('rejects malformed signature header', async () => {
    expect(await verifyWebhookSignature('{}', 'garbage', 'whsec')).toBe(false);
    expect(await verifyWebhookSignature('{}', '', 'whsec')).toBe(false);
    expect(await verifyWebhookSignature('{}', 't=123', 'whsec')).toBe(false);
  });
});
