import { describe, expect, it } from 'vitest';
import {
  actionPersonalData,
  evaluateUnscoped,
  isOpenUnscoped,
  personalDataExposure,
  validateApprovals,
  type UnscopedApproval,
  type UnscopedPolicyTool,
} from './unscoped-policy.js';

const unscoped = { caller_unscoped: { reason: 'shared rows' } };
const tool = (extra: Partial<UnscopedPolicyTool> = {}): UnscopedPolicyTool => ({
  name: 'list_tags', operation: 'query', sql: 'SELECT id, label FROM tags LIMIT 50', auth: unscoped, ...extra,
});
const approval = (action: string): UnscopedApproval => ({ action, reviewer: 'serge-ivo', date: '2026-10-20', reason: 'shared tag list' });
const approvals = (...names: string[]) => new Map(names.map((n) => [n, approval(n)]));

describe('isOpenUnscoped (#426)', () => {
  it('is an unscoped action any signed-in user can run', () => {
    expect(isOpenUnscoped(tool())).toBe(true);
    expect(isOpenUnscoped(tool({ callers: ['user', 'worker'] }))).toBe(true);
  });

  it('excludes scoped, public, scheduled, worker/hook-only and role-gated actions', () => {
    expect(isOpenUnscoped(tool({ auth: {} }))).toBe(false);
    expect(isOpenUnscoped(tool({ requires_auth: false }))).toBe(false);
    expect(isOpenUnscoped(tool({ schedule: { cron: '0 * * * *' } }))).toBe(false);
    expect(isOpenUnscoped(tool({ callers: ['worker'] }))).toBe(false);
    expect(isOpenUnscoped(tool({ callers: ['hook'] }))).toBe(false);
    expect(isOpenUnscoped(tool({ auth: { ...unscoped, app_roles: ['admin'] } }))).toBe(false);
    expect(isOpenUnscoped(tool({ auth: { ...unscoped, platform_roles: ['support'] } }))).toBe(false);
  });
});

describe('personalDataExposure (#426)', () => {
  it('finds personal-data output columns by name part, including aliases and RETURNING', () => {
    expect(personalDataExposure('SELECT u.id, u.email, u.phone_number FROM users u').columns).toEqual(['email', 'phone_number']);
    expect(personalDataExposure('SELECT id, home_address AS addr, date_of_birth FROM people').columns).toEqual(['date_of_birth', 'home_address']);
    expect(personalDataExposure('SELECT id, lat, lng FROM places').columns).toEqual(['lat', 'lng']);
    expect(personalDataExposure('SELECT id, x AS contact_email FROM t').columns).toEqual(['contact_email']);
    expect(personalDataExposure('UPDATE users SET seen = 1 WHERE id = :id RETURNING id, mobile').columns).toEqual(['mobile']);
  });

  it('ignores filters, joins, keys, counts, comments, literals and parameters', () => {
    expect(personalDataExposure('SELECT id, name FROM users WHERE email = :email').columns).toEqual([]);
    expect(personalDataExposure('SELECT p.id FROM places p JOIN locations l ON l.id = p.location_id').columns).toEqual([]);
    expect(personalDataExposure('SELECT location_id, email_count, email_verified FROM stats').columns).toEqual([]);
    expect(personalDataExposure("SELECT id, 'email' AS kind FROM t -- phone\n").columns).toEqual([]);
    expect(personalDataExposure('SELECT id, :email AS v FROM t').columns).toEqual([]);
    expect(personalDataExposure('SELECT (SELECT COUNT(*) FROM users u WHERE u.email IS NULL) AS n FROM t').columns).toEqual([]);
    expect(personalDataExposure('INSERT INTO t (email) VALUES (:email)').columns).toEqual([]);
  });

  it('a sub-select is checked as its own output list', () => {
    expect(personalDataExposure('SELECT id, (SELECT email FROM users WHERE users.id = t.owner) AS who FROM t').columns).toEqual(['email']);
  });

  it('treats * and t.* as exposing, but not COUNT(*)', () => {
    expect(personalDataExposure('SELECT * FROM users').star).toBe(true);
    expect(personalDataExposure('SELECT DISTINCT * FROM users').star).toBe(true);
    expect(personalDataExposure('SELECT u.*, 1 FROM users u').star).toBe(true);
    expect(personalDataExposure('SELECT u . * FROM users u').star).toBe(true);
    expect(personalDataExposure('DELETE FROM t WHERE id = :id RETURNING *').star).toBe(true);
    expect(personalDataExposure('SELECT COUNT(*) AS n FROM users').star).toBe(false);
    expect(personalDataExposure('SELECT a * 2 AS doubled FROM t').star).toBe(false);
  });

  it('covers every statement of a batch', () => {
    expect(actionPersonalData(tool({ operation: 'batch', sql: undefined, statements: ['UPDATE t SET n = 1', 'SELECT id, email FROM users'] })))
      .toEqual({ star: false, columns: ['email'] });
    expect(actionPersonalData(tool())).toBeNull();
  });
});

describe('validateApprovals (#426)', () => {
  it('accepts an absent list and well-formed entries', () => {
    expect(validateApprovals(undefined)).toEqual({ approvals: new Map() });
    const ok = validateApprovals([approval('list_tags')]);
    expect('approvals' in ok && ok.approvals.get('list_tags')).toEqual(approval('list_tags'));
  });

  it('requires all four fields, an ISO date, and one entry per action', () => {
    expect(validateApprovals({})).toEqual({ error: expect.stringMatching(/must be an array/) });
    expect(validateApprovals(['x'])).toEqual({ error: expect.stringMatching(/\[0\] must be an object/) });
    for (const field of ['action', 'reviewer', 'date', 'reason'] as const) {
      const entry: Record<string, unknown> = { ...approval('a') };
      delete entry[field];
      expect(validateApprovals([entry]), field).toEqual({ error: expect.stringContaining(`.${field} must be a non-empty string`) });
      expect(validateApprovals([{ ...approval('a'), [field]: '  ' }]), field).toEqual({ error: expect.stringContaining(`.${field}`) });
    }
    for (const date of ['20/10/2026', '2026-13-01', '2026-02-30', '2026-10-20T00:00:00Z']) {
      expect(validateApprovals([{ ...approval('a'), date }]), date).toEqual({ error: expect.stringMatching(/ISO date/) });
    }
    expect(validateApprovals([approval('a'), approval('a')])).toEqual({ error: expect.stringMatching(/approved twice/) });
  });
});

describe('evaluateUnscoped (#426)', () => {
  const none = new Map<string, UnscopedPolicyTool>();

  it('refuses a new unapproved open unscoped action', () => {
    const r = evaluateUnscoped({ tools: [tool()], approvals: approvals(), previous: none });
    expect(r.errors).toEqual([expect.stringMatching(/"list_tags" .*no approved_unscoped entry/)]);
  });

  it('accepts a new approved one', () => {
    expect(evaluateUnscoped({ tools: [tool()], approvals: approvals('list_tags'), previous: none })).toEqual({ errors: [], warnings: [], grandfathered: [] });
  });

  it('refuses personal data and * even when approved', () => {
    const pii = tool({ sql: 'SELECT id, email FROM users' });
    expect(evaluateUnscoped({ tools: [pii], approvals: approvals('list_tags'), previous: none }).errors)
      .toEqual([expect.stringMatching(/personal-data column\(s\) email.*approved or not/)]);
    const star = tool({ sql: 'SELECT * FROM tags' });
    expect(evaluateUnscoped({ tools: [star], approvals: approvals('list_tags'), previous: none }).errors)
      .toEqual([expect.stringMatching(/`\*`/)]);
  });

  it('grandfathers an unchanged registered action with a summary warning, and [SECURITY] for personal data', () => {
    const pii = tool({ name: 'get_user', sql: 'SELECT id, email FROM users WHERE id = :id' });
    const previous = new Map([['list_tags', tool()], ['get_user', pii]]);
    const r = evaluateUnscoped({ tools: [tool(), pii], approvals: approvals(), previous });
    expect(r.errors).toEqual([]);
    expect(r.grandfathered).toEqual(['list_tags', 'get_user']);
    expect(r.warnings).toEqual([
      expect.stringMatching(/^\[SECURITY\] tool "get_user" .*email/),
      '2 action(s) are caller_unscoped and require approval before next registration change: list_tags, get_user',
    ]);
  });

  it('treats changed statements, or newly opened access, as new', () => {
    const changed = evaluateUnscoped({ tools: [tool({ sql: 'SELECT id, label, colour FROM tags LIMIT 50' })], approvals: approvals(), previous: new Map([['list_tags', tool()]]) });
    expect(changed.errors).toHaveLength(1);
    const opened = evaluateUnscoped({ tools: [tool()], approvals: approvals(), previous: new Map([['list_tags', tool({ callers: ['worker'] })]]) });
    expect(opened.errors).toHaveLength(1);
  });

  it('leaves scheduled, worker-only, role-gated and public actions alone', () => {
    const tools = [
      tool({ name: 'a', schedule: { cron: '0 * * * *' }, sql: 'SELECT * FROM users' }),
      tool({ name: 'b', callers: ['worker'], sql: 'SELECT email FROM users' }),
      tool({ name: 'c', auth: { ...unscoped, app_roles: ['admin'] }, sql: 'SELECT email FROM users' }),
      tool({ name: 'd', requires_auth: false }),
    ];
    expect(evaluateUnscoped({ tools, approvals: approvals(), previous: none })).toEqual({ errors: [], warnings: [], grandfathered: [] });
  });

  it('warns about a stale approval', () => {
    expect(evaluateUnscoped({ tools: [tool({ callers: ['worker'] })], approvals: approvals('list_tags'), previous: none }).warnings)
      .toEqual([expect.stringMatching(/"list_tags" is not an open caller_unscoped action/)]);
  });

  it('without a registry (an app CI), gaps warn and only approved personal data fails', () => {
    const r = evaluateUnscoped({ tools: [tool(), tool({ name: 'who', sql: 'SELECT email FROM users' })], approvals: approvals(), previous: null });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([expect.stringMatching(/"list_tags"/), expect.stringMatching(/^\[SECURITY\] tool "who"/)]);
    expect(evaluateUnscoped({ tools: [tool({ name: 'who', sql: 'SELECT email FROM users' })], approvals: approvals('who'), previous: null }).errors).toHaveLength(1);
  });
});
