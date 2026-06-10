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

  it('starts signed out when localStorage throws during restore', () => {
    vi.stubGlobal('window', {
      location: { hash: '', href: 'https://proappstore.online/app/' },
      localStorage: {
        getItem: vi.fn(() => { throw new Error('storage blocked'); }),
        setItem: vi.fn(),
        removeItem: vi.fn(),
      },
    });

    const auth = new Auth('console', 'https://api.proappstore.online');

    expect(auth.user).toBeNull();
    expect(auth.token).toBeNull();
  });

  it('keeps a callback session in memory when localStorage write/remove throws', async () => {
    const localStorage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(() => { throw new Error('storage blocked'); }),
      removeItem: vi.fn(() => { throw new Error('storage blocked'); }),
    };
    const replaceState = vi.fn();
    vi.stubGlobal('window', {
      location: {
        hash: '#pas_session=callback-token',
        href: 'https://proappstore.online/app/#pas_session=callback-token',
        pathname: '/app/',
        search: '',
      },
      localStorage,
    });
    vi.stubGlobal('history', { replaceState });
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

    expect(auth.user?.login).toBe('creator');
    expect(auth.token).toBe('callback-token');
    expect(localStorage.setItem).toHaveBeenCalledOnce();
    expect(replaceState).toHaveBeenCalledWith(null, '', '/app/');

    expect(() => auth.signOut()).not.toThrow();
    expect(auth.user).toBeNull();
    expect(auth.token).toBeNull();
    expect(localStorage.removeItem).toHaveBeenCalledOnce();
  });

  it('starts OAuth through same-origin host auth routes in platform-cookie mode', () => {
    const assign = vi.fn();
    vi.stubGlobal('window', {
      location: {
        hash: '',
        href: 'https://interns.proappstore.online/dashboard?tab=people#old',
        origin: 'https://interns.proappstore.online',
        pathname: '/dashboard',
        search: '?tab=people',
        assign,
      },
    });

    const auth = new Auth('interns', 'https://api.proappstore.online', 'platform-cookie');
    auth.signIn('google');

    const url = new URL(assign.mock.calls[0][0]);
    expect(url.origin).toBe('https://interns.proappstore.online');
    expect(url.pathname).toBe('/.pas/auth/start');
    expect(url.searchParams.get('provider')).toBe('google');
    expect(url.searchParams.get('return_to')).toBe('/dashboard?tab=people');
    expect(auth.token).toBeNull();
  });

  it('hydrates platform-cookie sessions from same-origin /me without localStorage', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === '/.pas/auth/me') {
        return new Response(JSON.stringify({
          id: 'gh:123',
          login: 'creator',
          avatarUrl: null,
          roles: ['user'],
          appRoles: {},
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url === '/.pas/api/v1/apps/interns/roles/ensure-member') {
        return new Response(null, { status: 204 });
      }
      return new Response('unexpected', { status: 500 });
    });
    vi.stubGlobal('window', {
      location: {
        hash: '',
        href: 'https://interns.proappstore.online/',
        origin: 'https://interns.proappstore.online',
        pathname: '/',
        search: '',
      },
      localStorage: {
        getItem: vi.fn(() => { throw new Error('should not read storage'); }),
        setItem: vi.fn(() => { throw new Error('should not write storage'); }),
        removeItem: vi.fn(() => { throw new Error('should not clear storage'); }),
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    const auth = new Auth('interns', 'https://api.proappstore.online', 'platform-cookie');
    await auth.init();

    expect(auth.user?.login).toBe('creator');
    expect(auth.token).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith('/.pas/auth/me', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    expect(fetchMock).toHaveBeenCalledWith('/.pas/api/v1/apps/interns/roles/ensure-member', expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
    }));
  });

  it('rewrites API requests through same-origin mediation in platform-cookie mode', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('window', {
      location: {
        hash: '',
        href: 'https://interns.proappstore.online/',
        origin: 'https://interns.proappstore.online',
        pathname: '/',
        search: '',
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    const auth = new Auth('interns', 'https://api.proappstore.online', 'platform-cookie');
    await auth.init();
    await auth.authenticatedFetch('https://api.proappstore.online/v1/apps/interns/roles/me');

    expect(fetchMock).toHaveBeenLastCalledWith('/.pas/api/v1/apps/interns/roles/me', expect.objectContaining({
      credentials: 'same-origin',
    }));
    const init = fetchMock.mock.calls.at(-1)?.[1] as RequestInit;
    expect(new Headers(init.headers).get('Authorization')).toBeNull();
  });

  it('posts to same-origin logout in platform-cookie mode', () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('window', {
      location: {
        hash: '',
        href: 'https://interns.proappstore.online/',
        origin: 'https://interns.proappstore.online',
        pathname: '/',
        search: '',
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    const auth = new Auth('interns', 'https://api.proappstore.online', 'platform-cookie');
    auth.signOut();

    expect(fetchMock).toHaveBeenCalledWith('/.pas/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
    });
  });
});
