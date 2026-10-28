import { describe, expect, it, vi } from 'vitest';
import { BillingApi } from './billing.js';

// #509: the SDK's billing client. Every call goes to the app's own billing routes as the signed-in user; the server decides what they see.

function setup(reply: Response) {
  // A Response body reads once, so each call gets its own copy.
  const calls: { url: string; init: RequestInit }[] = [];
  const auth = {
    handleUnauthorized: vi.fn(),
    authenticatedFetch: vi.fn(async (input: string | URL, init: RequestInit = {}) => { calls.push({ url: String(input), init }); return reply.clone(); }),
  };
  return { api: new BillingApi('club', 'https://api.test', auth), auth, calls };
}
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('BillingApi', () => {
  it('products() reads the app products', async () => {
    const { api, calls } = setup(ok({ products: [{ key: 'term', name: 'Term' }] }));
    expect(await api.products()).toEqual([{ key: 'term', name: 'Term' }]);
    expect(calls[0]!.url).toBe('https://api.test/v1/apps/club/billing/products');
    expect(calls[0]!.init.method).toBe('GET');
  });

  it('checkout() posts the request and returns the url', async () => {
    const { api, calls } = setup(ok({ url: 'https://checkout.stripe.com/x', purchaseId: 'p1' }));
    const req = { product: 'term', subjects: ['a', 'b'], renew: true, successUrl: 'https://club.proappstore.online/ok', cancelUrl: 'https://club.proappstore.online/' };
    expect(await api.checkout(req)).toEqual({ url: 'https://checkout.stripe.com/x', purchaseId: 'p1' });
    expect(calls[0]!.url).toBe('https://api.test/v1/apps/club/billing/checkout');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual(req);
  });

  it('entitlements() sends the subject filter, encoded', async () => {
    const { api, calls } = setup(ok({ entitlements: [] }));
    await api.entitlements({ subjects: ['kid a', 'kid-b'] });
    expect(calls[0]!.url).toBe('https://api.test/v1/apps/club/billing/entitlements?subjects=kid%20a%2Ckid-b');
    await api.entitlements();
    expect(calls[1]!.url).toBe('https://api.test/v1/apps/club/billing/entitlements');
  });

  it('purchases() and portal() use their routes', async () => {
    const { api, calls } = setup(ok({ purchases: [], url: 'https://billing.stripe.com/p' }));
    expect(await api.purchases()).toEqual([]);
    expect(calls[0]!.url).toBe('https://api.test/v1/apps/club/billing/purchases');
    expect((await api.portal('https://club.proappstore.online/account')).url).toBe('https://billing.stripe.com/p');
    expect(calls[1]!.url).toBe('https://api.test/v1/apps/club/billing/portal');
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ returnUrl: 'https://club.proappstore.online/account' });
  });

  it('a 401 signs the user out and says so', async () => {
    const { api, auth } = setup(new Response('{}', { status: 401 }));
    await expect(api.products()).rejects.toThrow('Not signed in.');
    expect(auth.handleUnauthorized).toHaveBeenCalled();
  });

  it("a refusal carries the server's reason", async () => {
    const { api } = setup(new Response(JSON.stringify({ error: 'billing is not enabled for this app' }), { status: 403 }));
    await expect(api.products()).rejects.toThrow('billing.products failed: 403 billing is not enabled for this app');
  });
});
