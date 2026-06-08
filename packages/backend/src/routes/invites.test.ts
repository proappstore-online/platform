import { describe, expect, it, vi, beforeEach } from 'vitest';
import { app } from '../index.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function authAs(id: string, roles: string[] = ['user']) {
  mockFetch.mockResolvedValueOnce(
    new Response(JSON.stringify({ id, login: 'testuser', avatarUrl: null, roles }), { status: 200 }),
  );
}

interface InviteRow {
  id: string; app_id: string; code: string; role: string; group_id: string | null;
  metadata: string | null; max_uses: number; used_count: number;
  expires_at: number; created_by: string; created_at: number;
}

function makeEnv(opts: {
  creatorId?: string;
  teamMembers?: { user_id: string; role: string }[];
  invites?: InviteRow[];
} = {}) {
  const members = opts.teamMembers ?? [];
  const invites = opts.invites ?? [];
  let lastInserted: Record<string, unknown> | null = null;

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
            if (sql.includes('FROM invites') && sql.includes('code')) {
              const code = args[0];
              return invites.find(i => i.code === code) ?? null;
            }
            return null;
          },
          all: async () => {
            if (sql.includes('FROM invites')) return { results: invites };
            return { results: [] };
          },
          run: async () => ({ meta: { changes: 1 } }),
        }),
      }),
    } as unknown as D1Database,
    STORAGE: {} as R2Bucket,
    STRIPE_SECRET_KEY: 'sk',
    STRIPE_WEBHOOK_SECRET: 'wh',
    SESSION_SIGNING_KEY: 'test-signing-key',
    FAS_API_BASE: 'https://api.freeappstore.online',
    CF_API_TOKEN: 'cf',
    CF_ACCOUNT_ID: 'acct',
    VAPID_PUBLIC_KEY: 'vk',
    VAPID_PRIVATE_KEY: 'vs',
  };
}

function req(method: string, path: string, body?: unknown) {
  const init: RequestInit = {
    method,
    headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
  };
  if (body) init.body = JSON.stringify(body);
  return new Request(`https://api.test.com${path}`, init);
}

beforeEach(() => mockFetch.mockReset());

describe('POST /v1/apps/:appId/invites', () => {
  it('creates an invite with default values', async () => {
    authAs('gh:1');
    const env = makeEnv({ creatorId: 'gh:1' });
    const res = await app.fetch(req('POST', '/v1/apps/chess/invites', { role: 'student' }), env);
    expect(res.status).toBe(200);
    const data = await res.json() as { code: string; link: string; qr: string; role: string };
    expect(data.code).toMatch(/^[A-Z0-9]{6}$/);
    expect(data.link).toContain('chess.proappstore.online/join/');
    expect(data.qr).toContain('<svg');
    expect(data.role).toBe('student');
  });

  it('rejects owner role', async () => {
    authAs('gh:1');
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
});

describe('GET /v1/apps/:appId/invites', () => {
  it('lists invites for app owner', async () => {
    authAs('gh:1');
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
});

describe('DELETE /v1/apps/:appId/invites/:id', () => {
  it('revokes an invite', async () => {
    authAs('gh:1');
    const env = makeEnv({ creatorId: 'gh:1' });
    const res = await app.fetch(req('DELETE', '/v1/apps/chess/invites/inv1'), env);
    expect(res.status).toBe(200);
    const data = await res.json() as { ok: boolean };
    expect(data.ok).toBe(true);
  });
});

describe('POST /v1/invites/:code/redeem', () => {
  it('redeems a valid invite and assigns role', async () => {
    authAs('gh:2');
    // Mock the FAS service-assign call
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

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
    authAs('gh:2');
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
    authAs('gh:2');
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
    authAs('gh:2');
    const env = makeEnv({ invites: [] });
    const res = await app.fetch(req('POST', '/v1/invites/NOPE00/redeem'), env);
    expect(res.status).toBe(404);
  });
});
