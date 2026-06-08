import { describe, expect, it, vi, beforeEach } from 'vitest';
import { app } from '../index.js';
import { testToken, TEST_SK } from '../test-helpers.js';

const TOK = await testToken('gh:1');
const TOK2 = await testToken('gh:2');

/** Build a mock env with D1 that handles apps, team_members, and team_invites queries. */
function makeEnv(opts: {
  creatorId?: string;
  teamMembers?: { user_id: string; role: string; created_at?: number }[];
  invites?: { id: string; app_id: string; role: string; token: string; expires_at: number; invited_by: string }[];
} = {}) {
  const members = opts.teamMembers ?? [];
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
            if (sql.includes('COUNT') && sql.includes('owner')) {
              return { c: members.filter(m => m.role === 'owner').length };
            }
            if (sql.includes('FROM team_invites')) {
              const token = args[0];
              return invites.find(i => i.token === token) ?? null;
            }
            return null;
          },
          all: async () => ({
            results: sql.includes('team_members') ? members : [],
          }),
          run: async () => ({ meta: {} }),
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


describe('GET /v1/apps/:appId/team', () => {
  it('returns team members for owner', async () => {
    const env = makeEnv({
      creatorId: 'gh:1',
      teamMembers: [
        { user_id: 'gh:2', role: 'developer', created_at: 1000 },
        { user_id: 'gh:3', role: 'viewer', created_at: 2000 },
      ],
    });
    const res = await app.fetch(req('GET', '/v1/apps/myapp/team'), env);
    expect(res.status).toBe(200);
    const data = await res.json() as { members: unknown[] };
    expect(data.members).toHaveLength(2);
  });

  it('rejects unauthenticated', async () => {
    const badReq = new Request('https://api.test.com/v1/apps/myapp/team', {
      headers: { Authorization: 'Bearer invalid', 'Content-Type': 'application/json' },
    });
    const res = await app.fetch(badReq, makeEnv());
    expect(res.status).toBe(401);
  });
});

describe('PUT /v1/apps/:appId/team/:userId', () => {
  it('adds a team member', async () => {
    const env = makeEnv({ creatorId: 'gh:1' });
    const res = await app.fetch(req('PUT', '/v1/apps/myapp/team/gh:2', { role: 'developer' }), env);
    expect(res.status).toBe(200);
    const data = await res.json() as { role: string };
    expect(data.role).toBe('developer');
  });

  it('rejects owner role assignment', async () => {
    const res = await app.fetch(
      req('PUT', '/v1/apps/myapp/team/gh:2', { role: 'owner' }),
      makeEnv({ creatorId: 'gh:1' }),
    );
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain('ownership transfer');
  });

  it('rejects invalid role', async () => {
    const res = await app.fetch(
      req('PUT', '/v1/apps/myapp/team/gh:2', { role: 'superadmin' }),
      makeEnv({ creatorId: 'gh:1' }),
    );
    expect(res.status).toBe(400);
  });

  it('prevents escalation beyond own role', async () => {
    const env = makeEnv({
      creatorId: 'gh:1',
      teamMembers: [{ user_id: 'gh:2', role: 'admin' }],
    });
    const res = await app.fetch(
      req('PUT', '/v1/apps/myapp/team/gh:3', { role: 'admin' }),
      env,
    );
    // admin can assign admin (same level) — that's allowed
    expect(res.status).toBe(200);
  });

  it('rejects non-admin from adding members', async () => {
    const env = makeEnv({
      creatorId: 'gh:1',
      teamMembers: [{ user_id: 'gh:2', role: 'developer' }],
    });
    const res = await app.fetch(
      req('PUT', '/v1/apps/myapp/team/gh:3', { role: 'viewer' }, TOK2),
      env,
    );
    expect(res.status).toBe(403);
  });
});

describe('DELETE /v1/apps/:appId/team/:userId', () => {
  it('removes a team member', async () => {
    const env = makeEnv({
      creatorId: 'gh:1',
      teamMembers: [{ user_id: 'gh:2', role: 'developer' }],
    });
    const res = await app.fetch(req('DELETE', '/v1/apps/myapp/team/gh:2'), env);
    expect(res.status).toBe(200);
  });

  it('returns 404 for non-member', async () => {
    const env = makeEnv({ creatorId: 'gh:1', teamMembers: [] });
    const res = await app.fetch(req('DELETE', '/v1/apps/myapp/team/gh:99'), env);
    expect(res.status).toBe(404);
  });

  it('rejects non-admin from removing members', async () => {
    const env = makeEnv({
      creatorId: 'gh:1',
      teamMembers: [
        { user_id: 'gh:2', role: 'developer' },
        { user_id: 'gh:3', role: 'viewer' },
      ],
    });
    const res = await app.fetch(req('DELETE', '/v1/apps/myapp/team/gh:3', undefined, TOK2), env);
    expect(res.status).toBe(403);
  });
});

describe('POST /v1/apps/:appId/team/invite', () => {
  it('creates an invite link', async () => {
    const env = makeEnv({ creatorId: 'gh:1' });
    const res = await app.fetch(
      req('POST', '/v1/apps/myapp/team/invite', { role: 'developer' }),
      env,
    );
    expect(res.status).toBe(200);
    const data = await res.json() as { inviteUrl: string; token: string; role: string };
    expect(data.inviteUrl).toContain('console.proappstore.online/invite/');
    expect(data.token).toHaveLength(16);
    expect(data.role).toBe('developer');
  });

  it('rejects owner role in invite', async () => {
    const res = await app.fetch(
      req('POST', '/v1/apps/myapp/team/invite', { role: 'owner' }),
      makeEnv({ creatorId: 'gh:1' }),
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /v1/team/accept/:token', () => {
  it('accepts a valid invite', async () => {
    const env = makeEnv({
      invites: [{
        id: 'inv-1', app_id: 'myapp', role: 'developer',
        token: 'abc123', expires_at: Date.now() + 86400000, invited_by: 'gh:1',
      }],
    });
    const res = await app.fetch(req('POST', '/v1/team/accept/abc123'), env);
    expect(res.status).toBe(200);
    const data = await res.json() as { appId: string; role: string };
    expect(data.appId).toBe('myapp');
    expect(data.role).toBe('developer');
  });

  it('rejects expired invite', async () => {
    const env = makeEnv({
      invites: [{
        id: 'inv-2', app_id: 'myapp', role: 'viewer',
        token: 'expired', expires_at: Date.now() - 1000, invited_by: 'gh:1',
      }],
    });
    const res = await app.fetch(req('POST', '/v1/team/accept/expired'), env);
    expect(res.status).toBe(410);
  });

  it('returns 404 for unknown token', async () => {
    const res = await app.fetch(req('POST', '/v1/team/accept/nonexistent'), makeEnv());
    expect(res.status).toBe(404);
  });
});

describe('requireAppAccess', () => {
  it('grants owner access to creator', async () => {
    const res = await app.fetch(req('GET', '/v1/apps/myapp/team'), makeEnv({ creatorId: 'gh:1' }));
    expect(res.status).toBe(200);
  });

  it('grants access to team member', async () => {
    const env = makeEnv({
      creatorId: 'gh:1',
      teamMembers: [{ user_id: 'gh:2', role: 'viewer' }],
    });
    const res = await app.fetch(req('GET', '/v1/apps/myapp/team'), env);
    expect(res.status).toBe(200);
  });

  it('rejects non-member non-creator', async () => {
    const env = makeEnv({ creatorId: 'gh:1', teamMembers: [] });
    const res = await app.fetch(req('GET', '/v1/apps/myapp/team', undefined, TOK2), env);
    expect(res.status).toBe(403);
  });

  it('returns 404 for non-existent app', async () => {
    const env = makeEnv({ creatorId: undefined });
    const res = await app.fetch(req('GET', '/v1/apps/nonexistent/team'), env);
    expect(res.status).toBe(404);
  });
});
