import { describe, expect, it } from 'vitest';
import { app } from '../index.js';
import { makeEnv, mockD1, mockStmt, testToken } from '../test-helpers.js';
import { activityOf, joinDateOf } from './operator-users.js';
import { REFUSAL_CAP } from './operator-audit.js';

// #246: the platform-held users of an app, for its owner in the console
// operator view — present whether or not the app declares a contract.

const OWNER = await testToken('gh:1');
const auth = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });
const DAY = 86_400_000;

/** owner check (gh:1 created the app) → the users query → the audit insert. */
function db(rows: Record<string, unknown>[], creator = 'gh:1') {
  const users = mockStmt({ all: { results: rows } });
  const audit = mockStmt();
  const d = mockD1(mockStmt({ first: { creator_id: creator } }), users, audit);
  return { d, users, audit };
}
const list = (qs: string, d: ReturnType<typeof mockD1>, init: RequestInit = auth(OWNER)) =>
  app.request(`/v1/apps/stash/operator/users${qs}`, init, makeEnv({}, d));
const row = (i: number, patch: Record<string, unknown> = {}) => ({
  user_id: `gh:${String(i).padStart(3, '0')}`, login: `user${i}`, avatar_url: null, roles: '["member"]',
  first_granted: null, first_day: '2026-09-01', last_seen: Date.now() - DAY, ...patch,
});
const sqlOf = (d: ReturnType<typeof mockD1>) => d.prepare.mock.calls.map(([s]) => String(s));

describe('GET /v1/apps/:appId/operator/users (#246)', () => {
  it('lists the platform-held users with roles, join date and activity — no email, private, audited without results', async () => {
    const now = Date.now();
    const { d, users, audit } = db([
      row(1, { roles: '["moderator","member"]', first_granted: Date.parse('2026-08-15T10:00:00Z'), first_day: '2026-09-01', last_seen: now - DAY }),
      row(2, { login: null, roles: '[]', first_granted: null, first_day: '2026-01-02', last_seen: now - 40 * DAY }),
      row(3, { first_granted: 1_700_000_000_000, first_day: null, last_seen: null }),
    ]);
    const res = await list('', d);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    const body = (await res.json()) as { users: Record<string, unknown>[]; next_cursor: string | null };
    expect(body.next_cursor).toBeNull();
    expect(body.users).toEqual([
      { user_id: 'gh:001', login: 'user1', avatar_url: null, roles: ['moderator', 'member'], join_date: Date.parse('2026-08-15T10:00:00Z'), last_active: now - DAY, activity: 'active' },
      { user_id: 'gh:002', login: null, avatar_url: null, roles: [], join_date: Date.parse('2026-01-02T00:00:00Z'), last_active: now - 40 * DAY, activity: 'inactive' },
      { user_id: 'gh:003', login: 'user3', avatar_url: null, roles: ['member'], join_date: 1_700_000_000_000, last_active: null, activity: 'never_seen' },
    ]);
    // Scoped to the requested app, and the platform's email never leaves it.
    expect(users.bind).toHaveBeenCalledWith('stash', null, null, null, 51);
    expect(sqlOf(d)[1]).not.toMatch(/email/i);
    expect(JSON.stringify(body)).not.toMatch(/email/i);
    // One audit row: who, which read — no target, no results.
    expect(audit.bind).toHaveBeenCalledWith('stash', '', 'gh:1', '', 200, expect.any(Number), 'read:platform-users', null);
    expect(audit.bind).toHaveBeenCalledTimes(1);
  });

  it('pages 50 at a time on user_id', async () => {
    const { d } = db(Array.from({ length: 51 }, (_, i) => row(i + 1)));
    const body = (await (await list('?cursor=gh:000', d)).json()) as { users: unknown[]; next_cursor: string | null };
    expect(body.users).toHaveLength(50);
    expect(body.next_cursor).toBe('gh:050');
  });

  it('searches by login prefix or exact user id, with LIKE wildcards taken literally', async () => {
    const { d, users } = db([]);
    expect((await list('?q=%20a_b%25%20&cursor=gh:010', d)).status).toBe(200);
    expect(users.bind).toHaveBeenCalledWith('stash', 'gh:010', 'a_b%', 'a\\_b\\%%', 51);
  });

  it('refuses oversized input before querying, and records the owner\'s refusal once', async () => {
    for (const qs of [`?q=${'a'.repeat(101)}`, `?cursor=${'a'.repeat(201)}`]) {
      const refusal = mockStmt();
      const d = mockD1(mockStmt({ first: { creator_id: 'gh:1' } }), refusal);
      const res = await list(qs, d);
      expect(res.status, qs).toBe(400);
      expect(sqlOf(d).some((s) => /usage_daily|FROM app_roles/.test(s)), qs).toBe(false);
      expect(refusal.bind).toHaveBeenCalledWith('stash', '', 'gh:1', '', 400, expect.any(Number), 'read:platform-users', null, expect.any(Number), REFUSAL_CAP);
    }
  });

  it('refuses a signed-out caller (401), another app\'s owner and a team admin (403), before reading users', async () => {
    const anon = mockD1();
    expect((await list('', anon, {})).status).toBe(401);
    expect(anon.prepare).not.toHaveBeenCalled();
    for (const team of [null, { role: 'admin' }]) {
      const d = mockD1(mockStmt({ first: { creator_id: 'gh:9' } }), mockStmt({ first: team }));
      expect((await list('', d)).status).toBe(403);
      expect(sqlOf(d).some((s) => /usage_daily|app_action_audit/.test(s))).toBe(false);
    }
  });

  it('activity and join date', () => {
    const now = Date.parse('2026-09-28T12:00:00Z');
    expect(activityOf(null, now)).toBe('never_seen');
    expect(activityOf(now - 30 * DAY, now)).toBe('active');
    expect(activityOf(now - 30 * DAY - 1, now)).toBe('inactive');
    expect(joinDateOf(null, null)).toBeNull();
    expect(joinDateOf(null, '2026-09-01')).toBe(Date.parse('2026-09-01T00:00:00Z'));
    expect(joinDateOf(Date.parse('2026-09-02T00:00:00Z'), '2026-09-03')).toBe(Date.parse('2026-09-02T00:00:00Z'));
    expect(joinDateOf(Date.parse('2026-09-05T00:00:00Z'), '2026-09-03')).toBe(Date.parse('2026-09-03T00:00:00Z'));
    expect(joinDateOf(null, 'garbage')).toBeNull();
  });
});
