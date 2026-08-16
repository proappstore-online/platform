import { describe, expect, it, vi } from 'vitest';
import { fetchAccount } from './api-helpers.js';

const API_BASE = 'https://api.proappstore.online';
const INTERNAL = 'internal-token';

const account = {
  provider: 'google',
  providerLabel: 'Google',
  accountType: 'oauth',
  email: 'serge@example.com',
  emailVerified: true,
  createdAt: '2026-08-16T00:00:00.000Z',
  lastLoginAt: '2026-08-16T00:00:00.000Z',
};

const fetcher = (impl: (url: string, init?: RequestInit) => Response | Promise<Response>) => {
  const fetchMock = vi.fn(impl);
  return { api: { fetch: fetchMock } as unknown as Fetcher, fetchMock };
};

// #136: whoami reads email/provider from /v1/auth/me/account, which is gated on
// INTERNAL_TOKEN so creator app JS (which holds a session but not the shared
// worker secret) cannot reach it.
describe('fetchAccount', () => {
  it('sends both the session token and the internal token', async () => {
    const { api, fetchMock } = fetcher(() => Response.json(account));

    await expect(fetchAccount(api, API_BASE, 'session-jwt', INTERNAL)).resolves.toMatchObject({
      email: 'serge@example.com',
      providerLabel: 'Google',
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${API_BASE}/v1/auth/me/account`);
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer session-jwt');
    expect((init!.headers as Record<string, string>)['X-Internal-Token']).toBe(INTERNAL);
  });

  // Without the secret the request could only ever 403, so skip the round-trip.
  it('returns null without calling the API when INTERNAL_TOKEN is unset', async () => {
    const { api, fetchMock } = fetcher(() => Response.json(account));

    await expect(fetchAccount(api, API_BASE, 'session-jwt', undefined)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // whoami must keep printing the token-derived identity when this fails, so
  // every failure mode collapses to null rather than throwing.
  it('returns null on a non-ok response', async () => {
    const { api } = fetcher(() => new Response('forbidden', { status: 403 }));
    await expect(fetchAccount(api, API_BASE, 'session-jwt', INTERNAL)).resolves.toBeNull();
  });

  it('returns null when the service binding throws', async () => {
    const { api } = fetcher(() => { throw new Error('binding unavailable'); });
    await expect(fetchAccount(api, API_BASE, 'session-jwt', INTERNAL)).resolves.toBeNull();
  });

  it('returns null on a malformed body', async () => {
    const { api } = fetcher(() => new Response('not json', { status: 200 }));
    await expect(fetchAccount(api, API_BASE, 'session-jwt', INTERNAL)).resolves.toBeNull();
  });
});
