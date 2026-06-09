import { afterEach, describe, expect, it, vi } from 'vitest';
import { Auth } from './auth.js';

describe('Auth.init', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('hydrates a token-only session restored from a cross-subdomain cookie', async () => {
    const storage = new Map<string, string>([
      ['pas:session', JSON.stringify({ token: 'restored-token', user: null })],
    ]);
    const localStorage = {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
      removeItem: vi.fn((key: string) => storage.delete(key)),
    };
    vi.stubGlobal('window', {
      location: { hash: '', href: 'https://proappstore.online/app/' },
      localStorage,
    });
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/auth/me')) {
        return new Response(JSON.stringify({
          id: 'gh:123',
          login: 'creator',
          avatarUrl: null,
          roles: ['user', 'creator'],
          appRoles: {},
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(null, { status: 204 });
    }));

    const auth = new Auth('console', 'https://api.proappstore.online');
    await auth.init();

    expect(auth.user?.id).toBe('gh:123');
    expect(auth.token).toBe('restored-token');
    expect(JSON.parse(storage.get('pas:session')!).user.login).toBe('creator');
  });

  it('clears a token-only session when hydration is rejected', async () => {
    const storage = new Map<string, string>([
      ['pas:session', JSON.stringify({ token: 'expired-token', user: null })],
    ]);
    vi.stubGlobal('window', {
      location: { hash: '', href: 'https://proappstore.online/app/' },
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    });
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => (
      String(input).endsWith('/v1/auth/me')
        ? new Response('invalid', { status: 401 })
        : new Response(null, { status: 204 })
    )));

    const auth = new Auth('console', 'https://api.proappstore.online');
    await auth.init();

    expect(auth.user).toBeNull();
    expect(auth.token).toBeNull();
    expect(storage.has('pas:session')).toBe(false);
  });
});
