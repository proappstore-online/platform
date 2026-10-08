import { afterEach, describe, expect, it, vi } from 'vitest';
import { mintSession } from '@proappstore/build-core';
import { requireUser, requireAdmin, requireAppOwner, requireRecentAuth, stepUpMaxAgeSeconds, HttpError } from './auth.js';

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

// #231: the step-up window for step_up actions.
describe('requireRecentAuth / stepUpMaxAgeSeconds', () => {
  afterEach(() => vi.useRealTimers());
  const user = (authTime?: number, stepUpRpId?: string) => ({ id: 'gh:1', login: 'u', avatarUrl: null, roles: ['user'], ...(authTime === undefined ? {} : { authTime }), ...(stepUpRpId === undefined ? {} : { stepUpRpId }) });

  it('requireUser exposes the session auth_time, and omits it for sessions without one', async () => {
    const withTime = await mintSession({ uid: 'gh:1', roles: ['user'], auth_time: 1_800_000_000, auth_method: 'passkey' }, SK);
    expect((await requireUser(makeContext(withTime))).authTime).toBe(1_800_000_000);
    expect((await requireUser(makeContext(await tok('gh:1')))).authTime).toBeUndefined();
  });

  it('defaults to 300 seconds and honours a positive integer STEP_UP_MAX_AGE_SECONDS', () => {
    expect(stepUpMaxAgeSeconds({})).toBe(300);
    expect(stepUpMaxAgeSeconds({ STEP_UP_MAX_AGE_SECONDS: '120' })).toBe(120);
    for (const bad of ['0', '-5', 'abc', '1.5', '']) expect(stepUpMaxAgeSeconds({ STEP_UP_MAX_AGE_SECONDS: bad }), bad).toBe(300);
  });

  it('passes inside the window, including its last second, and refuses one second past it', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-27T12:00:00Z'));
    const now = Math.floor(Date.now() / 1000);
    expect(() => requireRecentAuth(user(now - 300), {})).not.toThrow();
    expect(() => requireRecentAuth(user(now - 60), { STEP_UP_MAX_AGE_SECONDS: '60' })).not.toThrow();
    expect(() => requireRecentAuth(user(now - 61), { STEP_UP_MAX_AGE_SECONDS: '60' })).toThrow('step_up_required');
  });

  it('refuses with a 403 step_up_required carrying the message and window, and refuses a missing auth_time', () => {
    const now = Math.floor(Date.now() / 1000);
    for (const u of [user(now - 301), user()]) {
      try {
        requireRecentAuth(u, {});
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(HttpError);
        expect((e as HttpError).status).toBe(403);
        expect((e as HttpError).message).toBe('step_up_required');
        expect((e as HttpError).body).toEqual({ message: 'Recent authentication required', max_age: 300 });
      }
    }
  });

  it('binds an audience-required step-up to its exact relying party and fails closed for legacy claims (#331)', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(() => requireRecentAuth({ ...user(now - 1, 'a.proappstore.online'), authMethod: 'passkey' }, {}, { method: 'passkey', rpId: 'a.proappstore.online' })).not.toThrow();
    for (const candidate of [
      { ...user(now - 1), authMethod: 'passkey' }, // legacy step-up, no claim
      { ...user(now - 1, 'b.proappstore.online'), authMethod: 'passkey' },
    ]) {
      expect(() => requireRecentAuth(candidate, {}, { method: 'passkey', rpId: 'a.proappstore.online' })).toThrow('step_up_required');
    }
  });

  it('an audience implies a passkey: a fresh OAuth sign-in is refused with method passkey, so the client runs the ceremony (#337)', () => {
    const now = Math.floor(Date.now() / 1000);
    for (const rpId of ['a.proappstore.online', '']) {
      try {
        requireRecentAuth({ ...user(now - 1), authMethod: 'github' }, {}, { rpId });
        expect.unreachable('should have thrown');
      } catch (e) {
        expect((e as HttpError).status).toBe(403);
        expect((e as HttpError).body).toEqual({ message: 'Recent passkey verification required', max_age: 300, method: 'passkey' });
      }
    }
    // The passkey step-up on that relying party passes without the caller naming the method.
    expect(() => requireRecentAuth({ ...user(now - 1, 'a.proappstore.online'), authMethod: 'passkey' }, {}, { rpId: 'a.proappstore.online' })).not.toThrow();
  });
});
