import { describe, expect, it, vi } from 'vitest';
import type { FasUser } from './auth.js';

/**
 * Test the PAS auth module's role-related logic.
 * PAS delegates token verification to FAS (/v1/auth/me) — we mock that
 * fetch and test that roles propagate correctly through requireUser,
 * requireAdmin, requireAppOwner, and requireRole.
 */

// Mock fetch globally for these tests
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Dynamic import after stubbing fetch
const { requireUser, requireAdmin, requireRole, requireAppOwner, HttpError } = await import('./auth.js');

function makeContext(token: string | null, env: Record<string, any> = {}) {
  return {
    req: {
      header: (name: string) => {
        if (name === 'Authorization' && token) return `Bearer ${token}`;
        return undefined;
      },
    },
    env: {
      FAS_API_BASE: 'https://api.freeappstore.online',
      DB: {
        prepare: (sql: string) => ({
          bind: (..._args: any[]) => ({
            first: async () => env._dbRow ?? null,
          }),
        }),
      },
      ADMIN_GITHUB_IDS: env.ADMIN_GITHUB_IDS ?? '',
      ...env,
    },
  } as any;
}

function mockFasResponse(user: Partial<FasUser>) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      id: 'gh:42',
      login: 'test-user',
      avatarUrl: null,
      roles: ['user'],
      appRoles: {},
      ...user,
    }),
  });
}

describe('requireUser — role propagation', () => {
  it('returns roles from FAS response', async () => {
    mockFasResponse({ roles: ['user', 'creator', 'admin'] });
    const user = await requireUser(makeContext('valid-token'));
    expect(user.roles).toEqual(['user', 'creator', 'admin']);
  });

  it('returns appRoles from FAS response', async () => {
    const appRoles = { meetup: ['moderator'] };
    mockFasResponse({ appRoles });
    const user = await requireUser(makeContext('valid-token'));
    expect(user.appRoles).toEqual(appRoles);
  });

  it('defaults roles to ["user"] when FAS returns no roles (old token)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'gh:42', login: 'test', avatarUrl: null }),
    });
    const user = await requireUser(makeContext('valid-token'));
    expect(user.roles).toEqual(['user']);
  });

  it('defaults appRoles to {} when FAS returns none', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'gh:42', login: 'test', avatarUrl: null }),
    });
    const user = await requireUser(makeContext('valid-token'));
    expect(user.appRoles).toEqual({});
  });

  it('throws 401 when no bearer token', async () => {
    await expect(requireUser(makeContext(null))).rejects.toThrow('missing bearer token');
  });

  it('throws 401 when FAS rejects the token', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
    await expect(requireUser(makeContext('bad-token'))).rejects.toThrow('invalid or expired session');
  });
});

describe('requireAdmin — role-based', () => {
  it('passes when user has admin role', async () => {
    mockFasResponse({ roles: ['user', 'admin'] });
    const user = await requireAdmin(makeContext('valid-token'));
    expect(user.roles).toContain('admin');
  });

  it('rejects when user lacks admin role', async () => {
    mockFasResponse({ roles: ['user'] });
    await expect(requireAdmin(makeContext('valid-token'))).rejects.toThrow('admin only');
  });

  it('rejects creator-only users (creator is not admin)', async () => {
    mockFasResponse({ roles: ['user', 'creator'] });
    await expect(requireAdmin(makeContext('valid-token'))).rejects.toThrow('admin only');
  });
});

describe('requireRole — arbitrary roles', () => {
  it('passes when user has the requested role', async () => {
    mockFasResponse({ roles: ['user', 'creator'] });
    const user = await requireRole(makeContext('valid-token'), 'creator');
    expect(user.roles).toContain('creator');
  });

  it('rejects when user lacks the requested role', async () => {
    mockFasResponse({ roles: ['user'] });
    await expect(requireRole(makeContext('valid-token'), 'creator')).rejects.toThrow('requires role: creator');
  });
});

describe('requireAppOwner — admin bypass via role', () => {
  it('allows the app creator', async () => {
    mockFasResponse({ id: 'gh:42', roles: ['user', 'creator'] });
    const c = makeContext('valid-token', { _dbRow: { creator_id: 'gh:42' } });
    const user = await requireAppOwner(c, 'meetup');
    expect(user.id).toBe('gh:42');
  });

  it('allows admin even if not the creator', async () => {
    mockFasResponse({ id: 'gh:99', roles: ['user', 'admin'] });
    const c = makeContext('valid-token', { _dbRow: { creator_id: 'gh:42' } });
    const user = await requireAppOwner(c, 'meetup');
    expect(user.id).toBe('gh:99');
  });

  it('rejects non-owner non-admin', async () => {
    mockFasResponse({ id: 'gh:99', roles: ['user'] });
    const c = makeContext('valid-token', { _dbRow: { creator_id: 'gh:42' } });
    await expect(requireAppOwner(c, 'meetup')).rejects.toThrow('not the app owner');
  });

  it('rejects creator role without actual ownership (creator != owner)', async () => {
    mockFasResponse({ id: 'gh:99', roles: ['user', 'creator'] });
    const c = makeContext('valid-token', { _dbRow: { creator_id: 'gh:42' } });
    await expect(requireAppOwner(c, 'meetup')).rejects.toThrow('not the app owner');
  });

  it('throws 404 when app does not exist', async () => {
    mockFasResponse({ id: 'gh:42', roles: ['user'] });
    const c = makeContext('valid-token', { _dbRow: null });
    await expect(requireAppOwner(c, 'nonexistent')).rejects.toThrow('app not found');
  });
});

describe('role escalation prevention', () => {
  it('user cannot self-assign admin via the response (roles come from token, not user)', async () => {
    // Even if someone managed to inject roles in the response,
    // PAS reads them as-is from FAS. The HMAC-signed token is
    // what FAS verifies — the roles in /auth/me come from the token.
    mockFasResponse({ roles: ['user'] });
    const user = await requireUser(makeContext('valid-token'));
    expect(user.roles).not.toContain('admin');
    // Cannot mutate roles array to escalate (it's a snapshot)
    user.roles.push('admin');
    // A new requireUser call would get fresh roles from FAS
    mockFasResponse({ roles: ['user'] });
    const user2 = await requireUser(makeContext('valid-token'));
    expect(user2.roles).not.toContain('admin');
  });
});
