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
    expect(r.contract.resources.map((x) => [x.id, x.kind])).toEqual([['members', 'users'], ['open_reports', 'reports'], ['suspension_history', 'suspensions'], ['moderation', 'metrics']]);
    expect(r.contract.resources[0]!.columns[0]).toEqual({ key: 'display_name', label: 'Name', format: 'text' });
    expect(r.contract.resources[0]!.description).toBeNull();
    expect(r.contract.actions[1]).toEqual({
      id: 'suspend_reported', title: 'Suspend user', resource: 'open_reports', action: 'op_suspend_user',
      params: { user_id: 'reported_user_id' }, confirm: 'Suspend the reported user?', step_up: true,
      transition: null, destructive: true, target: 'reported_user_id',
    });
  });

  it('a second app with different kinds validates through the same code', () => {
    const r = validateOperatorView(PARENTS_CLUBS.tools as ToolManifest[], PARENTS_CLUBS.operator_view);
    if (!('contract' in r) || !r.contract) throw new Error(JSON.stringify(r));
    expect(r.contract.resources.map((x) => x.kind)).toEqual(['users', 'reports', 'verification', 'suspensions', 'metrics']);
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
    expect(errorOf(stashTools, w)).toContain('must be an execute or batch write (reads belong in resources)');
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
    expect(r.contract.resources[3]).toMatchObject({ search: null, page: null, detail: null, status: null, related: null });
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
      [(m) => { m.page = { param: 'q', column: 'user_id' }; }, 'param "q" is already used by another capability'],
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

  it('keeps list capabilities on users, reports and suspensions resources', () => {
    const v = clone(STASH.operator_view);
    (v.resources[3] as Record<string, unknown>).search = { param: 'q' };
    expect(errorOf(stashTools, v)).toContain('search are only supported on users, reports, suspensions resources');
  });

  it('normalizes the reports & suspensions capabilities for both sample apps', () => {
    const r = validateOperatorView(stashTools, STASH.operator_view);
    if (!('contract' in r) || !r.contract) throw new Error(JSON.stringify(r));
    const reports = r.contract.resources[1]!;
    expect(reports.status).toEqual({ column: 'status', param: 'status', states: STASH.operator_view.resources[1]!.status!.states });
    expect(r.contract.resources[2]!.related).toEqual({ resource: 'members', param: 'user' });
    expect(r.contract.actions.find((a) => a.id === 'resolve')).toMatchObject({
      transition: { from: ['open', 'reviewing'], to: 'resolved' }, destructive: false, target: 'report_id', step_up: false,
    });
    expect(r.contract.actions.find((a) => a.id === 'suspend_member')).toMatchObject({ destructive: true, step_up: true, target: 'user_id', transition: null });
    const pc = validateOperatorView(PARENTS_CLUBS.tools as ToolManifest[], PARENTS_CLUBS.operator_view);
    if (!('contract' in pc) || !pc.contract) throw new Error(JSON.stringify(pc));
    expect(pc.contract.resources.find((x) => x.id === 'flags')!.status!.param).toBe('state');
    expect(pc.contract.resources.find((x) => x.id === 'suspended')!.related).toEqual({ resource: 'parents', param: 'parent' });
    expect(pc.contract.actions.find((a) => a.id === 'uphold')!.transition).toEqual({ from: ['new'], to: 'upheld' });
  });

  it('refuses a malformed status workflow or related list', () => {
    type Res = Record<string, unknown> & { status?: Record<string, unknown>; related?: Record<string, unknown> };
    const cases: Array<[number, (r: Res) => void, string]> = [
      [1, (r) => { r.status!.column = 'details'; }, 'status: column must be a declared column'],
      [1, (r) => { r.status!.states = []; }, 'states must be an array of 1-12'],
      [1, (r) => { (r.status!.states as unknown[]).push({ value: 'open', label: 'Again' }); }, 'duplicate state "open"'],
      [1, (r) => { (r.status!.states as unknown[]).push({ value: 'x', label: 'X', color: 'red' }); }, 'unknown field "color"'],
      [1, (r) => { r.status!.param = 'nope'; }, 'has no param "nope"'],
      [1, (r) => { r.status!.param = 'q'; }, 'param "q" is already used by another capability'],
      [2, (r) => { r.related!.resource = 'moderation'; }, 'related: resource must be another declared resource with a detail'],
      [2, (r) => { r.related!.resource = 'suspension_history'; }, 'related: resource must be another declared resource with a detail'],
      [2, (r) => { r.related!.resource = 'ghosts'; }, 'related: resource must be another declared resource with a detail'],
      [2, (r) => { r.related!.param = 'after'; }, 'param "after" is already used by another capability'],
    ];
    for (const [index, mutate, error] of cases) {
      const v = clone(STASH.operator_view);
      mutate(v.resources[index] as Res);
      expect(errorOf(stashTools, v), error).toContain(error);
    }
  });

  it('refuses unguarded transitions, unsafe destructive actions and undeclared targets', () => {
    type Act = Record<string, unknown> & { transition?: Record<string, unknown>; params: Record<string, string> };
    const byId = (v: typeof STASH.operator_view, id: string) => v.actions.find((a) => a.id === id) as Act;
    const cases: Array<[string, (a: Act) => void, string, ToolManifest[]?]> = [
      ['resolve', (a) => { a.transition!.from = ['closed']; }, 'from must be a non-empty list of declared states'],
      ['resolve', (a) => { a.transition!.to = 'archived'; }, 'to must be a declared state'],
      ['resolve', (a) => { delete a.params.from_status; }, 'guard the write with it',
        stashTools.map((t) => (t.name === 'op_resolve_report' ? { ...t, params: { report_id: { type: 'string' }, from_status: { type: 'string', optional: true } } } : t)) as ToolManifest[]],
      ['resolve', (a) => void a, 'guard the write with it',
        stashTools.map((t) => (t.name === 'op_resolve_report' ? { ...t, sql: "UPDATE reports SET status = 'resolved' WHERE id = :report_id" } : t)) as ToolManifest[]],
      ['suspend_member', (a) => { a.transition = { from: ['open'], to: 'resolved' }; }, 'resource "members" declares no status'],
      ['suspend_member', (a) => void a, 'destructive action "op_suspend_user" must declare step_up',
        stashTools.map((t) => (t.name === 'op_suspend_user' ? { ...t, step_up: undefined } : t)) as ToolManifest[]],
      ['suspend_member', (a) => { a.destructive = 'yes'; }, 'destructive must be a boolean'],
      ['resolve', (a) => { a.target = 'secret_notes'; }, 'target must be a declared column of resource "open_reports"'],
      ['resolve', (a) => { a.transition!.skip_guard = true; }, 'transition: unknown field "skip_guard"'],
    ];
    for (const [id, mutate, error, tools] of cases) {
      const v = clone(STASH.operator_view);
      mutate(byId(v, id));
      expect(errorOf(tools ?? stashTools, v), `${id}: ${error}`).toContain(error);
    }
  });
});

