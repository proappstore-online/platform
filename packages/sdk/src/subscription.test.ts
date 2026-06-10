import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SubscriptionApi } from './subscription.js';

interface AuthLike {
  token: string | null;
  handleUnauthorized: () => void;
  authenticatedFetch(input: string | URL, init?: RequestInit): Promise<Response>;
}

function fakeAuth(token: string | null): AuthLike {
  const auth: AuthLike = {
    token,
    handleUnauthorized: vi.fn(),
    async authenticatedFetch(input: string | URL, init: RequestInit = {}) {
      if (!auth.token) throw new Error('Not signed in.');
      const headers = { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${auth.token}` };
      return fetch(input, { ...init, headers });
    },
  };
  return auth;
}

describe('SubscriptionApi', () => {
  const originalFetch = globalThis.fetch;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('status', () => {
    it('returns Subscription on 200', async () => {
      const auth = fakeAuth('tok_sub');
      const api = new SubscriptionApi('myapp', 'https://api.proappstore.online', auth);
      const sub = {
        status: 'active',
        tier: 'pro',
        priceId: 'price_123',
        currentPeriodEnd: 1700000000000,
        cancelAtPeriodEnd: false,
      };
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(sub), { status: 200 }));

      const result = await api.status();

      expect(result).toEqual(sub);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/v1/subscription');
      expect(init.method).toBe('GET');
      expect(init.headers.Authorization).toBe('Bearer tok_sub');
    });

    it('returns null on 404', async () => {
      const auth = fakeAuth('tok_sub');
      const api = new SubscriptionApi('myapp', 'https://api.proappstore.online', auth);
      mockFetch.mockResolvedValueOnce(new Response('', { status: 404 }));

      const result = await api.status();

      expect(result).toBeNull();
    });

    it('throws on other non-ok status', async () => {
      const auth = fakeAuth('tok_sub');
      const api = new SubscriptionApi('myapp', 'https://api.proappstore.online', auth);
      mockFetch.mockResolvedValueOnce(new Response('', { status: 500 }));

      await expect(api.status()).rejects.toThrow('subscription.status failed: 500');
    });
  });

  describe('openCheckout', () => {
    it('sends POST with priceId, successUrl, cancelUrl', async () => {
      const auth = fakeAuth('tok_checkout');
      const api = new SubscriptionApi('myapp', 'https://api.proappstore.online', auth);
      const checkoutUrl = 'https://checkout.stripe.com/session_123';
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ url: checkoutUrl }), { status: 200 }));

      // Mock window.location.assign
      const assignMock = vi.fn();
      const originalWindow = globalThis.window;
      (globalThis as any).window = { location: { assign: assignMock } };

      await api.openCheckout({
        priceId: 'price_pro_monthly',
        successUrl: 'https://myapp.proappstore.online/success',
        cancelUrl: 'https://myapp.proappstore.online/',
      });

      const [url, init] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/v1/checkout');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({
        priceId: 'price_pro_monthly',
        successUrl: 'https://myapp.proappstore.online/success',
        cancelUrl: 'https://myapp.proappstore.online/',
      });
      expect(assignMock).toHaveBeenCalledWith(checkoutUrl);

      (globalThis as any).window = originalWindow;
    });

    it('throws on non-ok response', async () => {
      const auth = fakeAuth('tok_checkout');
      const api = new SubscriptionApi('myapp', 'https://api.proappstore.online', auth);
      mockFetch.mockResolvedValueOnce(new Response('', { status: 400 }));

      await expect(api.openCheckout({
        priceId: 'price_xxx',
        successUrl: 'http://x',
        cancelUrl: 'http://y',
      })).rejects.toThrow('subscription.openCheckout failed: 400');
    });
  });

  describe('openPortal', () => {
    it('sends POST with returnUrl', async () => {
      const auth = fakeAuth('tok_portal');
      const api = new SubscriptionApi('myapp', 'https://api.proappstore.online', auth);
      const portalUrl = 'https://billing.stripe.com/portal_123';
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ url: portalUrl }), { status: 200 }));

      const assignMock = vi.fn();
      const originalWindow = globalThis.window;
      (globalThis as any).window = { location: { assign: assignMock } };

      await api.openPortal('https://myapp.proappstore.online/');

      const [url, init] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/v1/portal');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({ returnUrl: 'https://myapp.proappstore.online/' });
      expect(assignMock).toHaveBeenCalledWith(portalUrl);

      (globalThis as any).window = originalWindow;
    });

    it('throws on non-ok response', async () => {
      const auth = fakeAuth('tok_portal');
      const api = new SubscriptionApi('myapp', 'https://api.proappstore.online', auth);
      mockFetch.mockResolvedValueOnce(new Response('', { status: 500 }));

      await expect(api.openPortal('http://x')).rejects.toThrow('subscription.openPortal failed: 500');
    });
  });

  describe('auth errors', () => {
    it('throws "Not signed in." when no token', async () => {
      const auth = fakeAuth(null);
      const api = new SubscriptionApi('myapp', 'https://api.proappstore.online', auth);

      await expect(api.status()).rejects.toThrow('Not signed in.');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('calls handleUnauthorized on 401', async () => {
      const auth = fakeAuth('tok_expired');
      const api = new SubscriptionApi('myapp', 'https://api.proappstore.online', auth);
      mockFetch.mockResolvedValueOnce(new Response('', { status: 401 }));

      await expect(api.status()).rejects.toThrow('Not signed in.');
      expect(auth.handleUnauthorized).toHaveBeenCalled();
    });
  });
});
