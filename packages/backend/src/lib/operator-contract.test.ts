import { describe, expect, it } from 'vitest';
import { validateOperatorView } from './operator-contract.js';
import type { ToolManifest } from './action-sql.js';
import { PARENTS_CLUBS, STASH } from '../__fixtures__/operator-view.js';

// #240 child 2: the operator-view contract is validated strictly against the
// app's own registered tools, so a stored contract is safe to render.

const stashTools = STASH.tools as ToolManifest[];
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const errorOf = (tools: ToolManifest[], view: unknown) => {
  const r = validateOperatorView(tools, view);
  return 'error' in r ? r.error : null;
};

describe('validateOperatorView (#240)', () => {
  it('absent or null is the baseline: no contract', () => {
    expect(validateOperatorView(stashTools, undefined)).toEqual({ contract: null });
    expect(validateOperatorView(stashTools, null)).toEqual({ contract: null });
  });

  it('normalizes a valid contract: default formats, null descriptions, step_up copied from the action', () => {
    const r = validateOperatorView(stashTools, STASH.operator_view);
    if (!('contract' in r) || !r.contract) throw new Error(JSON.stringify(r));
    expect(r.contract.version).toBe(1);
    expect(r.contract.resources.map((x) => [x.id, x.kind])).toEqual([['members', 'users'], ['open_reports', 'reports'], ['moderation', 'metrics']]);
    expect(r.contract.resources[0]!.columns[0]).toEqual({ key: 'display_name', label: 'Name', format: 'text' });
    expect(r.contract.resources[0]!.description).toBeNull();
    expect(r.contract.actions[1]).toEqual({
      id: 'suspend_reported', title: 'Suspend user', resource: 'open_reports', action: 'op_suspend_user',
      params: { user_id: 'reported_user_id' }, confirm: 'Suspend the reported user?', step_up: false,
    });
  });

  it('a second app with different kinds validates through the same code', () => {
    const r = validateOperatorView(PARENTS_CLUBS.tools as ToolManifest[], PARENTS_CLUBS.operator_view);
    if (!('contract' in r) || !r.contract) throw new Error(JSON.stringify(r));
    expect(r.contract.resources.map((x) => x.kind)).toEqual(['users', 'verification', 'suspensions', 'metrics']);
    expect(r.contract.actions[0]).toMatchObject({ id: 'approve', step_up: true });
  });

  it('rejects unknown versions, fields, kinds and formats', () => {
    const cases: Array<[(v: typeof STASH.operator_view & Record<string, unknown>) => void, string]> = [
      [(v) => { v.version = 2 as 1; }, 'operator_view.version must be one of 1'],
      [(v) => { delete (v as Record<string, unknown>).version; }, 'operator_view.version must be one of 1'],
      [(v) => { v.extra = true; }, 'operator_view: unknown field "extra"'],
      [(v) => { (v.resources[0] as Record<string, unknown>).sql = 'SELECT 1'; }, 'resources[0]: unknown field "sql"'],
      [(v) => { (v.resources[0]!.columns[0] as Record<string, unknown>).html = '<b>'; }, 'columns[0]: unknown field "html"'],
      [(v) => { (v.actions[0] as Record<string, unknown>).url = 'https://evil.test'; }, 'actions[0]: unknown field "url"'],
      [(v) => { v.resources[0]!.kind = 'payments'; }, 'kind must be one of users, reports, suspensions, verification, metrics'],
      [(v) => { (v.resources[0]!.columns[0] as Record<string, unknown>).format = 'html'; }, 'format must be one of text, number, datetime, boolean, badge'],
    ];
    for (const [mutate, error] of cases) {
      const view = clone(STASH.operator_view) as typeof STASH.operator_view & Record<string, unknown>;
      mutate(view);
      expect(errorOf(stashTools, view), error).toContain(error);
    }
  });

  it('rejects actions the manifest does not register or that are not safely gated', () => {
    const tool = (patch: Record<string, unknown>) => stashTools.map((t) => (t.name === 'op_list_users' ? { ...t, ...patch } : t)) as ToolManifest[];
    expect(errorOf(stashTools, { version: 1, resources: [{ ...STASH.operator_view.resources[0], action: 'drop_everything' }] }))
      .toContain('action "drop_everything" is not a tool in this manifest');
    expect(errorOf(tool({ auth: undefined }), STASH.operator_view)).toContain('must be gated by auth.app_roles');
    expect(errorOf(tool({ auth: { app_roles: ['member'], caller_unscoped: { reason: 'x' } } }), STASH.operator_view)).toContain("not 'member'");
    expect(errorOf(tool({ auth: { app_roles: ['operator', 'member'] } }), STASH.operator_view)).toContain("not 'member'");
    expect(errorOf(tool({ requires_auth: false }), STASH.operator_view)).toContain('is public');
    expect(errorOf(tool({ schedule: { cron: '0 3 * * *', params: {} } }), STASH.operator_view)).toContain('is scheduled');
  });

  it('keeps reads and writes apart, and resources callable without input', () => {
    const v = clone(STASH.operator_view);
    v.resources[0]!.action = 'op_suspend_user';
    expect(errorOf(stashTools, v)).toContain('must be a query');
    const w = clone(STASH.operator_view);
    w.actions[0]!.action = 'op_list_users';
    expect(errorOf(stashTools, w)).toContain('is a query; reads belong in resources');
    const needsInput = stashTools.map((t) => (t.name === 'op_list_reports' ? { ...t, params: { status: { type: 'string' } } } : t));
    expect(errorOf(needsInput, STASH.operator_view)).toContain('has required params (status)');
  });

  it('only renders columns the action selects', () => {
    const v = clone(STASH.operator_view);
    v.resources[0]!.columns.push({ key: 'password_hash', label: 'Hash' });
    expect(errorOf(stashTools, v)).toContain('does not select column "password_hash"');
    const dup = clone(STASH.operator_view);
    dup.resources[0]!.columns.push({ key: 'user_id', label: 'Again' });
    expect(errorOf(stashTools, dup)).toContain('duplicate column "user_id"');
  });

  it('maps every required action param from a column of the action’s resource', () => {
    const cases: Array<[(a: (typeof STASH.operator_view.actions)[number]) => void, string]> = [
      [(a) => { a.resource = 'nope'; }, 'resource must be the id of a declared resource'],
      [(a) => { a.params = { user: 'user_id' } as never; }, 'has no param "user"'],
      [(a) => { a.params = { user_id: 'report_id' }; }, 'must name a column of resource "members"'],
      [(a) => { a.params = {} as never; }, 'required params of "op_suspend_user" are not mapped: user_id'],
      [(a) => { a.confirm = ''; }, 'confirm is required'],
    ];
    for (const [mutate, error] of cases) {
      const v = clone(STASH.operator_view);
      mutate(v.actions[0]!);
      expect(errorOf(stashTools, v), error).toContain(error);
    }
  });

  it('rejects duplicate ids, bad ids and oversized lists', () => {
    const dup = clone(STASH.operator_view);
    dup.actions[0]!.id = 'members';
    expect(errorOf(stashTools, dup)).toContain('duplicate id "members"');
    const bad = clone(STASH.operator_view);
    bad.resources[0]!.id = 'Members!';
    expect(errorOf(stashTools, bad)).toContain('id must match');
    const many = { version: 1, resources: Array.from({ length: 21 }, (_, i) => ({ ...STASH.operator_view.resources[0], id: `r${i}` })) };
    expect(errorOf(stashTools, many)).toContain('at most 20');
    expect(errorOf(stashTools, [])).toBe('operator_view must be an object');
    expect(errorOf(stashTools, { version: 1, resources: {} })).toContain('resources must be an array');
  });

  it('normalizes the users capability: search, keyset page sized by the literal LIMIT, detail with step_up copied', () => {
    const r = validateOperatorView(stashTools, STASH.operator_view);
    if (!('contract' in r) || !r.contract) throw new Error(JSON.stringify(r));
    const members = r.contract.resources[0]!;
    expect(members.search).toEqual({ param: 'q' });
    expect(members.page).toEqual({ param: 'after', column: 'user_id', size: 50 });
    expect(members.detail).toMatchObject({ action: 'op_member_detail', param: 'user_id', key: 'user_id', step_up: false });
    expect(members.detail!.fields.map((f) => f.key)).toEqual(['display_name', 'user_id', 'email', 'pocket_count', 'created_at']);
    // Resources without the capability carry explicit nulls.
    expect(r.contract.resources[1]).toMatchObject({ search: null, page: null, detail: null });
    const parents = validateOperatorView(PARENTS_CLUBS.tools as ToolManifest[], PARENTS_CLUBS.operator_view);
    if (!('contract' in parents) || !parents.contract) throw new Error(JSON.stringify(parents));
    expect(parents.contract.resources[0]!.page).toEqual({ param: 'cursor', column: 'user_id', size: 25 });
  });

  it('refuses an unsafe or malformed users capability', () => {
    type Members = (typeof STASH.operator_view.resources)[0] & Record<string, unknown>;
    const withTool = (name: string, patch: Record<string, unknown>) =>
      stashTools.map((t) => (t.name === name ? { ...t, ...patch } : t)) as ToolManifest[];
    const cases: Array<[(m: Members) => void, string, ToolManifest[]?]> = [
      [(m) => { m.search = { param: 'nope' }; }, 'has no param "nope"'],
      [(m) => { m.search = { param: 'q', like: true }; }, 'search: unknown field "like"'],
      [(m) => { m.page = { param: 'after', column: 'email' }; }, 'column must be a declared column'],
      [(m) => { m.page = { param: 'q', column: 'user_id' }; }, 'param must differ from search.param'],
      [(m) => void m, 'literal LIMIT of 1-200', withTool('op_list_users', { sql: "SELECT m.id AS user_id, m.display_name, m.created_at, m.suspended FROM members m WHERE (:q IS NULL OR m.display_name LIKE :q) AND (:after IS NULL OR m.id > :after) ORDER BY m.id LIMIT 500" })],
      [(m) => void m, 'must ORDER BY', withTool('op_list_users', { sql: "SELECT m.id AS user_id, m.display_name, m.created_at, m.suspended FROM members m WHERE (:q IS NULL OR m.display_name LIKE :q) AND (:after IS NULL OR m.id > :after) LIMIT 50" })],
      [(m) => { m.detail!.fields.push({ key: 'ssn', label: 'SSN' }); }, 'does not select column "ssn"'],
      [(m) => { m.detail!.key = 'email'; }, 'key must be a declared column of the resource'],
      [(m) => { m.detail!.param = 'nope'; }, 'has no param "nope"'],
      [(m) => { m.detail!.action = 'op_suspend_user'; }, 'must be a query'],
      [(m) => void m, 'must be gated by auth.app_roles', withTool('op_member_detail', { auth: undefined })],
      [(m) => void m, 'is public', withTool('op_member_detail', { requires_auth: false })],
      [(m) => { (m.detail as Record<string, unknown>).sql = 'x'; }, 'detail: unknown field "sql"'],
    ];
    for (const [mutate, error, tools] of cases) {
      const v = clone(STASH.operator_view);
      mutate(v.resources[0] as Members);
      expect(errorOf(tools ?? stashTools, v), error).toContain(error);
    }
  });

  it('keeps the users capability on users resources', () => {
    const v = clone(STASH.operator_view);
    (v.resources[1] as Record<string, unknown>).search = { param: 'status' };
    expect(errorOf(stashTools, v)).toContain('search are only supported on users resources');
  });
});
