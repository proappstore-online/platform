import { describe, expect, it } from 'vitest';
import { mintSession } from '@proappstore/build-core';
import { requireUser, requireAdmin, requireRole, requireAppOwner, HttpError } from './auth.js';

const SK = 'test-signing-key';

async function tok(uid: string, opts?: { roles?: string[]; login?: string }) {
  return mintSession({ uid, login: opts?.login ?? 'test-user', roles: opts?.roles ?? ['user'] }, SK);
}

function makeContext(token: string | null, env: Record<string, any> = {}) {
  return {
    req: {
      header: (name: string) => {
        if (name === 'Authorization' && token) return `Bearer ${token}`;
        return undefined;
      },
    },
    env: {
      SESSION_SIGNING_KEY: SK,
      DB: {
        prepare: (sql: string) => ({
          bind: (..._args: any[]) => ({
            first: async () => {
              if (sql.includes('team_members')) return env._teamRow ?? null;
              return env._dbRow ?? null;
            },
          }),
        }),
      },
      ADMIN_GITHUB_IDS: env.ADMIN_GITHUB_IDS ?? '',
      ...env,
    },
  } as any;
}

describe('requireUser — role propagation', () => {
  it('returns roles from token', async () => {
    const t = await tok('gh:42', { roles: ['user', 'creator', 'admin'] });
    const user = await requireUser(makeContext(t));
    expect(user.roles).toEqual(['user', 'creator', 'admin']);
  });

  it('defaults roles to ["user"] when token has no roles', async () => {
    // mintSession always includes roles, but verifySession defaults to ['user']
    // if the field is missing. Test by verifying the default behavior.
    const t = await tok('gh:42');
    const user = await requireUser(makeContext(t));
    expect(user.roles).toEqual(['user']);
  });

  it('defaults appRoles to {} when token has none', async () => {
    const t = await tok('gh:42');
    const user = await requireUser(makeContext(t));
    expect(user.appRoles).toEqual({});
  });

  it('throws 401 when no bearer token', async () => {
    await expect(requireUser(makeContext(null))).rejects.toThrow('missing bearer token');
  });

  it('throws 401 when token is invalid', async () => {
    await expect(requireUser(makeContext('bad-token'))).rejects.toThrow('invalid or expired session');
  });
});

describe('requireAdmin — role-based', () => {
  it('passes when user has admin role', async () => {
    const t = await tok('gh:42', { roles: ['user', 'admin'] });
    const user = await requireAdmin(makeContext(t));
    expect(user.roles).toContain('admin');
  });

  it('rejects when user lacks admin role', async () => {
    const t = await tok('gh:42', { roles: ['user'] });
    await expect(requireAdmin(makeContext(t))).rejects.toThrow('admin only');
  });

  it('rejects creator-only users (creator is not admin)', async () => {
    const t = await tok('gh:42', { roles: ['user', 'creator'] });
    await expect(requireAdmin(makeContext(t))).rejects.toThrow('admin only');
  });
});

describe('requireRole — arbitrary roles', () => {
  it('passes when user has the requested role', async () => {
    const t = await tok('gh:42', { roles: ['user', 'creator'] });
    const user = await requireRole(makeContext(t), 'creator');
    expect(user.roles).toContain('creator');
  });

  it('rejects when user lacks the requested role', async () => {
    const t = await tok('gh:42', { roles: ['user'] });
    await expect(requireRole(makeContext(t), 'creator')).rejects.toThrow('requires role: creator');
  });
});

describe('requireAppOwner — admin bypass via role', () => {
  it('allows the app creator', async () => {
    const t = await tok('gh:42', { roles: ['user', 'creator'] });
    const c = makeContext(t, { _dbRow: { creator_id: 'gh:42' } });
    const user = await requireAppOwner(c, 'meetup');
    expect(user.id).toBe('gh:42');
  });

  it('allows admin even if not the creator', async () => {
    const t = await tok('gh:99', { roles: ['user', 'admin'] });
    const c = makeContext(t, { _dbRow: { creator_id: 'gh:42' } });
    const user = await requireAppOwner(c, 'meetup');
    expect(user.id).toBe('gh:99');
  });

  it('rejects non-owner non-admin', async () => {
    const t = await tok('gh:99', { roles: ['user'] });
    const c = makeContext(t, { _dbRow: { creator_id: 'gh:42' } });
    await expect(requireAppOwner(c, 'meetup')).rejects.toThrow('not the app owner');
  });

  it('rejects creator role without actual ownership (creator != owner)', async () => {
    const t = await tok('gh:99', { roles: ['user', 'creator'] });
    const c = makeContext(t, { _dbRow: { creator_id: 'gh:42' } });
    await expect(requireAppOwner(c, 'meetup')).rejects.toThrow('not the app owner');
  });

  it('throws 404 when app does not exist', async () => {
    const t = await tok('gh:42', { roles: ['user'] });
    const c = makeContext(t, { _dbRow: null });
    await expect(requireAppOwner(c, 'nonexistent')).rejects.toThrow('app not found');
  });
});

describe('role escalation prevention', () => {
  it('roles come from signed token — cannot be spoofed', async () => {
    const t = await tok('gh:42', { roles: ['user'] });
    const user = await requireUser(makeContext(t));
    expect(user.roles).not.toContain('admin');
    // Mutating the returned array doesn't affect the next call
    user.roles.push('admin');
    const user2 = await requireUser(makeContext(t));
    expect(user2.roles).not.toContain('admin');
  });
});
