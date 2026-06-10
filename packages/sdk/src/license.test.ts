import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LicenseApi } from './license.js';

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

describe('LicenseApi', () => {
  const originalFetch = globalThis.fetch;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('current', () => {
    it('returns LicenseInfo on success', async () => {
      const auth = fakeAuth('tok_lic');
      const api = new LicenseApi('myapp', 'https://api.proappstore.online', auth);
      const license = {
        key: 'LIC-ABC-123',
        appId: 'myapp',
        issuedAt: 1700000000000,
        expiresAt: 1730000000000,
      };
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(license), { status: 200 }));

      const result = await api.current();

      expect(result).toEqual(license);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/v1/apps/myapp/license');
      expect(init.headers.Authorization).toBe('Bearer tok_lic');
    });

    it('returns null when no token', async () => {
      const auth = fakeAuth(null);
      const api = new LicenseApi('myapp', 'https://api.proappstore.online', auth);

      const result = await api.current();

      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns null on 404', async () => {
      const auth = fakeAuth('tok_lic');
      const api = new LicenseApi('myapp', 'https://api.proappstore.online', auth);
      mockFetch.mockResolvedValueOnce(new Response('', { status: 404 }));

      const result = await api.current();

      expect(result).toBeNull();
    });

    it('calls handleUnauthorized and returns null on 401', async () => {
      const auth = fakeAuth('tok_expired');
      const api = new LicenseApi('myapp', 'https://api.proappstore.online', auth);
      mockFetch.mockResolvedValueOnce(new Response('', { status: 401 }));

      const result = await api.current();

      expect(result).toBeNull();
      expect(auth.handleUnauthorized).toHaveBeenCalled();
    });

    it('throws on other non-ok status', async () => {
      const auth = fakeAuth('tok_lic');
      const api = new LicenseApi('myapp', 'https://api.proappstore.online', auth);
      mockFetch.mockResolvedValueOnce(new Response('', { status: 500 }));

      await expect(api.current()).rejects.toThrow('license.current failed: 500');
    });

    it('encodes appId in the URL', async () => {
      const auth = fakeAuth('tok_lic');
      const api = new LicenseApi('my app', 'https://api.proappstore.online', auth);
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ key: 'K', appId: 'my app', issuedAt: 0, expiresAt: null }), { status: 200 }));

      await api.current();

      const [url] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/v1/apps/my%20app/license');
    });
  });

  describe('validate', () => {
    it('returns true when server confirms valid', async () => {
      const auth = fakeAuth('tok_lic');
      const api = new LicenseApi('myapp', 'https://api.proappstore.online', auth);
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ valid: true }), { status: 200 }));

      const result = await api.validate('LIC-ABC-123');

      expect(result).toBe(true);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/v1/license/validate');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({ appId: 'myapp', key: 'LIC-ABC-123' });
    });

    it('returns false when server confirms invalid', async () => {
      const auth = fakeAuth('tok_lic');
      const api = new LicenseApi('myapp', 'https://api.proappstore.online', auth);
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ valid: false }), { status: 200 }));

      const result = await api.validate('BAD-KEY');

      expect(result).toBe(false);
    });

    it('returns false on non-ok response', async () => {
      const auth = fakeAuth('tok_lic');
      const api = new LicenseApi('myapp', 'https://api.proappstore.online', auth);
      mockFetch.mockResolvedValueOnce(new Response('', { status: 500 }));

      const result = await api.validate('KEY');

      expect(result).toBe(false);
    });

    it('does not require auth token (public endpoint)', async () => {
      const auth = fakeAuth(null);
      const api = new LicenseApi('myapp', 'https://api.proappstore.online', auth);
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ valid: true }), { status: 200 }));

      const result = await api.validate('LIC-123');

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalled();
    });
  });
});
