import { describe, expect, it, vi, beforeEach } from 'vitest';
import { app } from '../index.js';
import { testToken, TEST_SK } from '../test-helpers.js';

const TOK = await testToken('gh:1');
const DELEGATE_TOK = await testToken('gh:2', { login: 'delegate' });

interface InviteRow {
  id: string; app_id: string; code: string; role: string; group_id: string | null;
  metadata: string | null; max_uses: number; used_count: number;
  expires_at: number; created_by: string; created_at: number;
}

function makeEnv(opts: {
  creatorId?: string;
  teamMembers?: { user_id: string; role: string }[];
  appRoles?: { user_id: string; role_name: string }[];
  policies?: { delegate_role: string; grantable_role: string }[];
  groupGrants?: { user_id: string; group_id: string }[];
  invites?: InviteRow[];
} = {}) {
  const members = opts.teamMembers ?? [];
  const appRoles = opts.appRoles ?? [];
  const policies = opts.policies ?? [];
  const groupGrants = opts.groupGrants ?? [];
  const invites = opts.invites ?? [];

  return {
    DB: {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          first: async () => {
            if (sql.includes('FROM apps')) {
              return opts.creatorId ? { creator_id: opts.creatorId } : null;
            }
            if (sql.includes('FROM team_members') && sql.includes('user_id')) {
              const userId = args[1] ?? args[0];
              return members.find(m => m.user_id === userId) ?? null;
            }
            if (sql.includes('app_invite_policies')) {
              const appId = args[0];
              if (sql.includes('p.grantable_role')) {
                const [, group, userId, role] = args;
                return groupGrants.some(g => g.group_id === group && g.user_id === userId)
                  && policies.some(p => p.grantable_role === role && appRoles.some(r => r.user_id === userId && r.role_name === p.delegate_role))
                  ? { 1: 1 } : null;
              }
              const [, userId] = args;
              return policies.some(p => appRoles.some(r => r.user_id === userId && r.role_name === p.delegate_role))
                ? { 1: 1 } : null;
            }
            if (sql.includes('FROM invites') && sql.includes('code')) {
              const code = args[0];
              return invites.find(i => i.code === code) ?? null;
            }
            return null;
          },
          all: async () => {
            if (sql.includes('FROM app_group_admin_grants')) {
              const [, userId] = args;
              return { results: groupGrants.filter(g => g.user_id === userId).map(g => ({ group_id: g.group_id })) };
            }
            if (sql.includes('FROM invites')) {
              const groups = args.slice(1) as string[];
              return { results: groups.length ? invites.filter(i => i.group_id !== null && groups.includes(i.group_id)) : invites };
            }
            return { results: [] };
          },
          run: async () => {
            if (sql.startsWith('DELETE FROM invites') && sql.includes('group_id IN')) {
              const [, , ...groups] = args as string[];
              const id = args[0] as string;
              return { meta: { changes: invites.some(i => i.id === id && i.group_id !== null && groups.includes(i.group_id)) ? 1 : 0 } };
            }
            return { meta: { changes: 1 } };
          },
        }),
      }),
    } as unknown as D1Database,
    STORAGE: {} as R2Bucket,
    STRIPE_SECRET_KEY: 'sk',
    STRIPE_WEBHOOK_SECRET: 'wh',
    SESSION_SIGNING_KEY: TEST_SK,
    CF_API_TOKEN: 'cf',
    CF_ACCOUNT_ID: 'acct',
    VAPID_PUBLIC_KEY: 'vk',
    VAPID_PRIVATE_KEY: 'vs',
  };
}

function req(method: string, path: string, body?: unknown, token = TOK) {
  const init: RequestInit = {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  };
  if (body) init.body = JSON.stringify(body);
  return new Request(`https://api.test.com${path}`, init);
}


describe('POST /v1/apps/:appId/invites', () => {
  it('creates an invite with default values', async () => {
    const env = makeEnv({ creatorId: 'gh:1' });
    const res = await app.fetch(req('POST', '/v1/apps/chess/invites', { role: 'student' }), env);
    expect(res.status).toBe(200);
    const data = await res.json() as { code: string; link: string; qr: string; role: string };
    expect(data.code).toMatch(/^[A-Z0-9]{6}$/);
    expect(data.link).toContain('chess.proappstore.online/join/');
    expect(data.qr).toContain('<svg');
    expect(data.role).toBe('student');
  });

  it('rejects a developer inviting a role above their own (no privilege escalation)', async () => {
    // gh:1 is a developer (not the owner gh:99). Inviting 'admin' would grant a
    // privileged, action-gating role the developer cannot assign directly.
    const env = makeEnv({ creatorId: 'gh:99', teamMembers: [{ user_id: 'gh:1', role: 'developer' }] });
    const res = await app.fetch(req('POST', '/v1/apps/chess/invites', { role: 'admin' }), env);
    expect(res.status).toBe(403);
  });

  it('keeps normal developer invite access app-wide', async () => {
    const env = makeEnv({ creatorId: 'gh:99', teamMembers: [{ user_id: 'gh:1', role: 'developer' }] });
    const res = await app.fetch(req('POST', '/v1/apps/chess/invites', {
      role: 'student', group: 'any-tenant',
    }), env);
    expect(res.status).toBe(200);
  });

  it('rejects a malformed role string', async () => {
    const env = makeEnv({ creatorId: 'gh:1' });
    const res = await app.fetch(req('POST', '/v1/apps/chess/invites', { role: 'Admin Role!' }), env);
    expect(res.status).toBe(400);
  });

  it('lets an owner invite a privileged role', async () => {
    const env = makeEnv({ creatorId: 'gh:1' }); // gh:1 is owner
    const res = await app.fetch(req('POST', '/v1/apps/chess/invites', { role: 'admin' }), env);
    expect(res.status).toBe(200);
  });

  it('rejects owner role', async () => {
    const env = makeEnv({ creatorId: 'gh:1' });
    const res = await app.fetch(req('POST', '/v1/apps/chess/invites', { role: 'owner' }), env);
    expect(res.status).toBe(400);
  });

  it('rejects unauthenticated users', async () => {
    const env = makeEnv({ creatorId: 'gh:1' });
    const res = await app.fetch(
      new Request('https://api.test.com/v1/apps/chess/invites', { method: 'POST' }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it('allows a configured data-role delegate to invite only its policy role in its granted group', async () => {
    const env = makeEnv({
      creatorId: 'gh:99',
      appRoles: [{ user_id: 'gh:2', role_name: 'org_admin' }],
      policies: [{ delegate_role: 'org_admin', grantable_role: 'student' }],
      groupGrants: [{ user_id: 'gh:2', group_id: 'school-a' }],
    });
    const res = await app.fetch(req('POST', '/v1/apps/chess/invites', {
      role: 'student', group: 'school-a',
    }, DELEGATE_TOK), env);
    expect(res.status).toBe(200);
  });

  it('refuses a delegate outside its group or grantable-role policy', async () => {
    const env = makeEnv({
      creatorId: 'gh:99',
      appRoles: [{ user_id: 'gh:2', role_name: 'org_admin' }],
      policies: [{ delegate_role: 'org_admin', grantable_role: 'student' }],
      groupGrants: [{ user_id: 'gh:2', group_id: 'school-a' }],
    });
    const foreign = await app.fetch(req('POST', '/v1/apps/chess/invites', {
      role: 'student', group: 'school-b',
    }, DELEGATE_TOK), env);
    expect(foreign.status).toBe(403);

    const escalated = await app.fetch(req('POST', '/v1/apps/chess/invites', {
      role: 'teacher', group: 'school-a',
    }, DELEGATE_TOK), env);
    expect(escalated.status).toBe(403);
  });
});

describe('GET /v1/apps/:appId/invites', () => {
  it('lists invites for app owner', async () => {
    const env = makeEnv({
      creatorId: 'gh:1',
      invites: [{
        id: 'inv1', app_id: 'chess', code: 'ABC123', role: 'student',
        group_id: null, metadata: null, max_uses: 30, used_count: 5,
        expires_at: Date.now() + 86400000, created_by: 'gh:1', created_at: Date.now(),
      }],
    });
    const res = await app.fetch(req('GET', '/v1/apps/chess/invites'), env);
    expect(res.status).toBe(200);
    const data = await res.json() as { invites: { code: string }[] };
    expect(data.invites).toHaveLength(1);
    expect(data.invites[0]!.code).toBe('ABC123');
  });

  it('lists only the delegate’s administered group invites', async () => {
    const env = makeEnv({
      creatorId: 'gh:99',
      appRoles: [{ user_id: 'gh:2', role_name: 'org_admin' }],
      policies: [{ delegate_role: 'org_admin', grantable_role: 'student' }],
      groupGrants: [{ user_id: 'gh:2', group_id: 'school-a' }],
      invites: [
        { id: 'a', app_id: 'chess', code: 'SCHA01', role: 'student', group_id: 'school-a', metadata: null, max_uses: 1, used_count: 0, expires_at: Date.now() + 86400000, created_by: 'gh:2', created_at: Date.now() },
        { id: 'b', app_id: 'chess', code: 'SCHB01', role: 'student', group_id: 'school-b', metadata: null, max_uses: 1, used_count: 0, expires_at: Date.now() + 86400000, created_by: 'gh:3', created_at: Date.now() },
      ],
    });
    const res = await app.fetch(req('GET', '/v1/apps/chess/invites', undefined, DELEGATE_TOK), env);
    expect(res.status).toBe(200);
    expect((await res.json() as { invites: { id: string }[] }).invites.map(i => i.id)).toEqual(['a']);
  });
});

describe('DELETE /v1/apps/:appId/invites/:id', () => {
  it('revokes an invite', async () => {
    const env = makeEnv({ creatorId: 'gh:1' });
    const res = await app.fetch(req('DELETE', '/v1/apps/chess/invites/inv1'), env);
    expect(res.status).toBe(200);
    const data = await res.json() as { ok: boolean };
    expect(data.ok).toBe(true);
  });

  it('does not reveal or revoke a different group’s invite to a delegate', async () => {
    const env = makeEnv({
      creatorId: 'gh:99',
      appRoles: [{ user_id: 'gh:2', role_name: 'org_admin' }],
      policies: [{ delegate_role: 'org_admin', grantable_role: 'student' }],
      groupGrants: [{ user_id: 'gh:2', group_id: 'school-a' }],
      invites: [{ id: 'foreign', app_id: 'chess', code: 'SCHB01', role: 'student', group_id: 'school-b', metadata: null, max_uses: 1, used_count: 0, expires_at: Date.now() + 86400000, created_by: 'gh:3', created_at: Date.now() }],
    });
    const res = await app.fetch(req('DELETE', '/v1/apps/chess/invites/foreign', undefined, DELEGATE_TOK), env);
    expect(res.status).toBe(404);
  });
});

describe('delegated invite administration', () => {
  it('lets a team admin set policy and group grants, without granting an app role', async () => {
    const env = makeEnv({ creatorId: 'gh:1' });
    const policy = await app.fetch(req('POST', '/v1/apps/chess/invite-policies', {
      delegateRole: 'org_admin', grantableRole: 'student',
    }), env);
    expect(policy.status).toBe(200);
    expect(await policy.json()).toMatchObject({ ok: true, delegateRole: 'org_admin', grantableRole: 'student' });

    const grant = await app.fetch(req('POST', '/v1/apps/chess/group-admin-grants', {
      userId: 'gh:2', group: 'school-a',
    }), env);
    expect(grant.status).toBe(200);
    expect(await grant.json()).toMatchObject({ ok: true, userId: 'gh:2', group: 'school-a' });
  });

  it('does not let a group grant substitute for a policy-backed app role', async () => {
    const env = makeEnv({
      creatorId: 'gh:99',
      groupGrants: [{ user_id: 'gh:2', group_id: 'school-a' }],
    });
    const res = await app.fetch(req('POST', '/v1/apps/chess/invites', {
      role: 'student', group: 'school-a',
    }, DELEGATE_TOK), env);
    expect(res.status).toBe(403);
  });

  it('restricts policy and group-grant management to the app team', async () => {
    const env = makeEnv({ creatorId: 'gh:99' });
    const res = await app.fetch(req('POST', '/v1/apps/chess/invite-policies', {
      delegateRole: 'org_admin', grantableRole: 'student',
    }, DELEGATE_TOK), env);
    expect(res.status).toBe(403);
  });
});

describe('POST /v1/invites/:code/redeem', () => {
  it('redeems a valid invite and assigns role', async () => {
    const env = makeEnv({
      invites: [{
        id: 'inv1', app_id: 'chess', code: 'HKWX3P', role: 'student',
        group_id: 'org-1', metadata: '{"teacherId":"t1"}', max_uses: 30, used_count: 5,
        expires_at: Date.now() + 86400000, created_by: 'gh:1', created_at: Date.now(),
      }],
    });
    const res = await app.fetch(req('POST', '/v1/invites/HKWX3P/redeem'), env);
    expect(res.status).toBe(200);
    const data = await res.json() as { ok: boolean; role: string; group: string; metadata: { teacherId: string } };
    expect(data.ok).toBe(true);
    expect(data.role).toBe('student');
    expect(data.group).toBe('org-1');
    expect(data.metadata).toEqual({ teacherId: 't1' });
  });

  it('rejects expired invite', async () => {
    const env = makeEnv({
      invites: [{
        id: 'inv1', app_id: 'chess', code: 'EXPRD1', role: 'student',
        group_id: null, metadata: null, max_uses: 30, used_count: 5,
        expires_at: Date.now() - 1000, created_by: 'gh:1', created_at: Date.now() - 86400000,
      }],
    });
    const res = await app.fetch(req('POST', '/v1/invites/EXPRD1/redeem'), env);
    expect(res.status).toBe(410);
  });

  it('rejects fully used invite', async () => {
    const env = makeEnv({
      invites: [{
        id: 'inv1', app_id: 'chess', code: 'FULL01', role: 'student',
        group_id: null, metadata: null, max_uses: 5, used_count: 5,
        expires_at: Date.now() + 86400000, created_by: 'gh:1', created_at: Date.now(),
      }],
    });
    const res = await app.fetch(req('POST', '/v1/invites/FULL01/redeem'), env);
    expect(res.status).toBe(410);
  });

  it('rejects unknown code', async () => {
    const env = makeEnv({ invites: [] });
    const res = await app.fetch(req('POST', '/v1/invites/NOPE00/redeem'), env);
    expect(res.status).toBe(404);
  });
});
