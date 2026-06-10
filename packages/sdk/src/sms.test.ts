import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SMS } from './sms.js';

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

describe('SMS', () => {
  const originalFetch = globalThis.fetch;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('send', () => {
    it('POSTs to /v1/sms/send with single recipient', async () => {
      const sms = new SMS('myapp', 'https://api.proappstore.online', fakeAuth('tok'));
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ sent: 1, failed: 0 }), { status: 200 }),
      );

      const r = await sms.send('+15551234567', 'class in 1h');

      expect(r).toEqual({ sent: 1, failed: 0 });
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.proappstore.online/v1/sms/send');
      expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toBe('Bearer tok');
      expect(JSON.parse(init.body)).toEqual({
        appId: 'myapp',
        to: ['+15551234567'],
        message: 'class in 1h',
      });
    });

    it('throws when not signed in', async () => {
      const sms = new SMS('myapp', 'https://api.proappstore.online', fakeAuth(null));
      await expect(sms.send('+15551234567', 'hi')).rejects.toThrow(/Not signed in/);
    });

    it('clears session on 401 and throws', async () => {
      const auth = fakeAuth('tok');
      const sms = new SMS('myapp', 'https://api.proappstore.online', auth);
      mockFetch.mockResolvedValueOnce(new Response('', { status: 401 }));

      await expect(sms.send('+15551234567', 'hi')).rejects.toThrow(/Not signed in/);
      expect(auth.handleUnauthorized).toHaveBeenCalledTimes(1);
    });

    it('throws a helpful message on 403', async () => {
      const sms = new SMS('myapp', 'https://api.proappstore.online', fakeAuth('tok'));
      mockFetch.mockResolvedValueOnce(new Response('', { status: 403 }));
      await expect(sms.send('+15551234567', 'hi')).rejects.toThrow(/Only the app creator/);
    });

    it('throws a helpful message on 503', async () => {
      const sms = new SMS('myapp', 'https://api.proappstore.online', fakeAuth('tok'));
      mockFetch.mockResolvedValueOnce(new Response('', { status: 503 }));
      await expect(sms.send('+15551234567', 'hi')).rejects.toThrow(/not configured/);
    });
  });

  describe('broadcast', () => {
    it('POSTs all numbers in a single request', async () => {
      const sms = new SMS('myapp', 'https://api.proappstore.online', fakeAuth('tok'));
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ sent: 3, failed: 0 }), { status: 200 }),
      );

      const r = await sms.broadcast(['+15551111111', '+15552222222', '+15553333333'], 'hi all');

      expect(r).toEqual({ sent: 3, failed: 0 });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.to).toEqual(['+15551111111', '+15552222222', '+15553333333']);
      expect(body.message).toBe('hi all');
    });
  });
});
