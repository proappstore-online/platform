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
    expect(r.contract.resources.map((x) => [x.id, x.kind])).toEqual([['members', 'users'], ['open_reports', 'reports'], ['suspension_history', 'suspensions'], ['kyc', 'verification'], ['moderation', 'metrics'], ['growth', 'metrics']]);
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
    expect(r.contract.resources.map((x) => x.kind)).toEqual(['users', 'reports', 'verification', 'suspensions', 'metrics', 'metrics']);
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
    expect(r.contract.resources[4]).toMatchObject({ search: null, page: null, detail: null, status: null, related: null });
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

  it('a KPI metrics resource is aggregate numbers only (#245); a series keeps its time and breakdown columns', () => {
    const moderation = () => {
      const v = clone(STASH.operator_view);
      return { v, r: v.resources.find((r) => r.id === 'moderation') as { columns: { key: string; label: string; format?: string }[] } };
    };
    for (const format of ['text', 'badge', 'datetime', 'boolean', undefined]) {
      const { v, r } = moderation();
      r.columns[1] = { key: 'suspended_users', label: 'Suspended', ...(format ? { format } : {}) };
      expect(errorOf(stashTools, v), String(format)).toContain('column "suspended_users" must have format "number"');
    }
    // A per-user query dressed as a KPI: its identifying column is not a number.
    const tools = [...stashTools, { ...stashTools.find((t) => t.name === 'op_report_metrics')!, name: 'op_leaky', sql: 'SELECT email, COUNT(*) AS n FROM members GROUP BY email' }];
    const leaky = clone(STASH.operator_view);
    leaky.resources.push({ id: 'leaky', kind: 'metrics', title: 'Leaky', action: 'op_leaky', columns: [{ key: 'email', label: 'Email' }, { key: 'n', label: 'N', format: 'number' }] } as never);
    expect(errorOf(tools as ToolManifest[], leaky)).toContain('column "email" must have format "number"');
    // Both samples, including their series (day, plan, week_start), still register.
    expect(errorOf(stashTools, STASH.operator_view)).toBeNull();
    expect(errorOf(PARENTS_CLUBS.tools as ToolManifest[], PARENTS_CLUBS.operator_view)).toBeNull();
  });

  it('keeps list capabilities off metrics resources', () => {
    const v = clone(STASH.operator_view);
    (v.resources[4] as Record<string, unknown>).search = { param: 'q' };
    expect(errorOf(stashTools, v)).toContain('search are only supported on users, reports, suspensions, verification resources');
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

  it('normalizes the verification queues of both sample apps', () => {
    const r = validateOperatorView(stashTools, STASH.operator_view);
    if (!('contract' in r) || !r.contract) throw new Error(JSON.stringify(r));
    const kyc = r.contract.resources.find((x) => x.id === 'kyc')!;
    expect(kyc.detail).toMatchObject({ step_up: true, evidence: [{ field: 'document_path', label: 'ID document' }, { field: 'selfie_path', label: 'Selfie' }] });
    expect(r.contract.actions.find((a) => a.id === 'approve_kyc')).toMatchObject({ step_up: true, transition: { from: ['pending'], to: 'approved' }, target: 'request_id' });
    const pc = validateOperatorView(PARENTS_CLUBS.tools as ToolManifest[], PARENTS_CLUBS.operator_view);
    if (!('contract' in pc) || !pc.contract) throw new Error(JSON.stringify(pc));
    expect(pc.contract.resources.find((x) => x.id === 'id_checks')!.detail!.evidence).toEqual([{ field: 'licence_path', label: "Driver's licence" }]);
    expect(pc.contract.actions.filter((a) => a.resource === 'id_checks').map((a) => [a.id, a.step_up, a.transition?.to])).toEqual([['approve', true, 'approved'], ['decline', true, 'declined']]);
  });

  it('refuses a verification queue without the workflow, the detail page or the recent-sign-in requirement', () => {
    type Res = Record<string, unknown> & { detail?: Record<string, unknown> & { fields: { key: string }[] } };
    const kycIndex = STASH.operator_view.resources.findIndex((x) => x.id === 'kyc');
    const withTool = (name: string, patch: Record<string, unknown>) => stashTools.map((t) => (t.name === name ? { ...t, ...patch } : t)) as ToolManifest[];
    const cases: Array<[(r: Res, v: typeof STASH.operator_view) => void, string, ToolManifest[]?]> = [
      [(r, v) => { delete r.status; v.actions = v.actions.filter((a) => a.resource !== 'kyc'); }, 'a verification resource must declare status and detail'],
      [(r, v) => { delete r.detail; v.actions = v.actions.filter((a) => a.resource !== 'kyc'); }, 'a verification resource must declare status and detail'],
      [(r) => void r, 'action "op_kyc_detail" must declare step_up (identity data needs a recent sign-in)', withTool('op_kyc_detail', { step_up: undefined })],
      [(r) => { r.detail!.fields = r.detail!.fields.filter((f) => f.key !== 'status'); }, 'fields must include the status column "status"'],
      [(r) => void r, 'action "op_approve_kyc" must declare step_up (every verification decision needs a recent sign-in)', withTool('op_approve_kyc', { step_up: undefined })],
      [(r, v) => { delete (v.actions.find((a) => a.id === 'approve_kyc') as Record<string, unknown>).transition; }, 'decisions on a verification resource must be status transitions'],
      [(r) => { r.detail!.fields = r.detail!.fields.filter((f) => f.key !== 'request_id'); }, 'column "request_id" must also be a detail field of "kyc"'],
      [(r) => { r.detail!.evidence = [{ field: 'internal_score', label: 'Score' }]; }, 'field must be a declared detail field'],
      [(r) => { r.detail!.evidence = [{ field: 'document_path', label: 'A' }, { field: 'document_path', label: 'B' }]; }, 'duplicate field "document_path"'],
      [(r) => { r.detail!.evidence = [{ field: 'document_path', label: 'ID', url: 'https://x' }]; }, 'evidence[0]: unknown field "url"'],
      [(r) => { r.detail!.evidence = []; }, 'evidence must be an array of 1-6'],
    ];
    for (const [mutate, error, tools] of cases) {
      const v = clone(STASH.operator_view);
      mutate(v.resources[kycIndex] as Res, v);
      expect(errorOf(tools ?? stashTools, v), error).toContain(error);
    }
    const members = clone(STASH.operator_view);
    (members.resources[0]!.detail as Record<string, unknown>).evidence = [{ field: 'email', label: 'Email' }];
    expect(errorOf(stashTools, members)).toContain('evidence: only verification resources declare evidence');
  });

  it('normalizes the metric time series of both sample apps', () => {
    const r = validateOperatorView(stashTools, STASH.operator_view);
    if (!('contract' in r) || !r.contract) throw new Error(JSON.stringify(r));
    expect(r.contract.resources.find((x) => x.id === 'growth')!.series).toEqual({
      time: { column: 'day', grain: 'day' },
      range: { from_param: 'from', to_param: 'to', default_days: 30, max_days: 366 },
      measures: [{ column: 'signups', label: 'Sign-ups', unit: 'count', currency: null, aggregation: 'sum' }],
      dimension: { column: 'plan', label: 'Plan', max_values: 3 },
    });
    expect(r.contract.resources.find((x) => x.id === 'moderation')!.series).toBeNull();
    const pc = validateOperatorView(PARENTS_CLUBS.tools as ToolManifest[], PARENTS_CLUBS.operator_view);
    if (!('contract' in pc) || !pc.contract) throw new Error(JSON.stringify(pc));
    const trends = pc.contract.resources.find((x) => x.id === 'club_trends')!.series!;
    expect(trends.time.grain).toBe('week');
    expect(trends.measures.map((m) => [m.unit, m.currency, m.aggregation])).toEqual([['percent', null, 'avg'], ['count', null, 'sum'], ['currency', 'GBP', 'sum']]);
    expect(trends.dimension).toBeNull();
  });

  it('refuses malformed or unbounded series declarations', () => {
    type Series = Record<string, unknown> & { time: Record<string, unknown>; range: Record<string, unknown>; measures: Record<string, unknown>[]; dimension?: Record<string, unknown> };
    const at = STASH.operator_view.resources.findIndex((x) => x.id === 'growth');
    const withSql = (sql: string) => stashTools.map((t) => (t.name === 'op_daily_signups' ? { ...t, sql } : t)) as ToolManifest[];
    const cases: Array<[(s: Series) => void, string, ToolManifest[]?]> = [
      [(s) => { s.colour = 'red'; }, 'series: unknown field "colour"'],
      [(s) => { s.time.column = 'created_at'; }, 'time: column must be a declared column'],
      [(s) => { s.time.grain = 'hour'; }, 'grain must be one of day, week, month'],
      [(s) => { s.range.from_param = 'since'; }, 'has no param "since"'],
      [(s) => { s.range.to_param = 'from'; }, 'from_param and to_param must differ'],
      [(s) => { s.range.max_days = 0; }, 'max_days must be an integer from 1 to 731'],
      [(s) => { s.range.max_days = 5000; }, 'max_days must be an integer from 1 to 731'],
      [(s) => { s.range.max_days = 30.5; }, 'max_days must be an integer from 1 to 731'],
      [(s) => { s.range.default_days = 400; }, 'default_days must be an integer from 1 to max_days'],
      [(s) => void s, 'must end with a literal LIMIT of 1-5000', withSql('SELECT d.day, d.plan, d.signups FROM daily_signups d WHERE d.day >= :from AND d.day <= :to')],
      [(s) => void s, 'must end with a literal LIMIT of 1-5000', withSql('SELECT d.day, d.plan, d.signups FROM daily_signups d WHERE d.day >= :from AND d.day <= :to LIMIT 9000')],
      [(s) => { s.measures = []; }, 'measures must be an array of 1-4'],
      [(s) => { s.measures[0]!.unit = 'furlongs'; }, 'unit must be one of count, percent, seconds, bytes, currency'],
      [(s) => { s.measures[0]!.unit = 'currency'; }, 'currency must be an ISO 4217 code'],
      [(s) => { s.measures[0]!.unit = 'currency'; s.measures[0]!.currency = 'euro'; }, 'currency must be an ISO 4217 code'],
      [(s) => { s.measures[0]!.currency = 'EUR'; }, 'currency is only allowed when unit is currency'],
      [(s) => { s.measures[0]!.aggregation = 'median'; }, 'aggregation must be one of sum, avg, min, max'],
      [(s) => { s.measures[0]!.column = 'day'; }, 'column "day" is already used'],
      [(s) => { s.measures[0]!.label = ''; }, 'label is required'],
      [(s) => { s.measures[0]!.sql = 'x'; }, 'measures[0]: unknown field "sql"'],
      [(s) => { s.measures.push({ column: 'plan', label: 'Plan', unit: 'count', aggregation: 'sum' }); delete s.dimension; s.measures.push({ column: 'day', label: 'x', unit: 'count', aggregation: 'sum' }); }, 'column "day" is already used'],
      [(s) => { s.dimension!.max_values = 9; }, 'max_values must be an integer from 1 to 8'],
      [(s) => { s.dimension!.column = 'signups'; }, 'dimension: column "signups" is already used'],
      [(s) => { s.dimension!.column = 'region'; }, 'dimension: column must be a declared column'],
    ];
    for (const [mutate, error, tools] of cases) {
      const v = clone(STASH.operator_view);
      mutate((v.resources[at] as Record<string, unknown>).series as Series);
      expect(errorOf(tools ?? stashTools, v), error).toContain(error);
    }
    // A breakdown takes exactly one measure.
    const pc = clone(PARENTS_CLUBS.operator_view);
    const trends = pc.resources.find((x) => x.id === 'club_trends') as Record<string, unknown> & { series: Record<string, unknown> };
    trends.series.dimension = { column: 'events', label: 'Events', max_values: 3 };
    expect(errorOf(PARENTS_CLUBS.tools as ToolManifest[], pc)).toContain('dimension: column "events" is already used');
    (trends.columns as unknown[]).push({ key: 'club', label: 'Club' });
    trends.series.dimension = { column: 'club', label: 'Club', max_values: 3 };
    expect(errorOf(PARENTS_CLUBS.tools as ToolManifest[], pc)).toContain('does not select column "club"');
    // Series only on metrics resources.
    const members = clone(STASH.operator_view);
    (members.resources[0] as Record<string, unknown>).series = clone((STASH.operator_view.resources[at] as Record<string, unknown>).series);
    expect(errorOf(stashTools, members)).toContain('series is only supported on metrics resources');
  });

  it('normalizes the audit declaration: absent for Stash (owner alone), roles for Parents Clubs', () => {
    const r = validateOperatorView(stashTools, STASH.operator_view);
    if (!('contract' in r) || !r.contract) throw new Error(JSON.stringify(r));
    expect(r.contract.audit).toBeNull();
    const pc = validateOperatorView(PARENTS_CLUBS.tools as ToolManifest[], PARENTS_CLUBS.operator_view);
    if (!('contract' in pc) || !pc.contract) throw new Error(JSON.stringify(pc));
    expect(pc.contract.audit).toEqual({ app_roles: ['operator'] });
    const dup = clone(STASH.operator_view) as Record<string, unknown>;
    dup.audit = { app_roles: ['auditor', 'auditor', 'operator'] };
    const d = validateOperatorView(stashTools, dup);
    expect('contract' in d && d.contract?.audit).toEqual({ app_roles: ['auditor', 'operator'] });
  });

  it('refuses a malformed or everyone-holds-it audit declaration', () => {
    for (const [audit, error] of [
      [[], 'operator_view.audit must be an object'],
      [{ app_roles: [] }, 'app_roles must be 1-5 app role names'],
      [{ app_roles: ['a', 'b', 'c', 'd', 'e', 'f'] }, 'app_roles must be 1-5 app role names'],
      [{ app_roles: ['Operator'] }, 'app_roles must be 1-5 app role names'],
      [{ app_roles: ['member'] }, "cannot include 'member'"],
      [{ app_roles: ['operator'], public: true }, 'audit: unknown field "public"'],
    ] as const) {
      const v = clone(STASH.operator_view) as Record<string, unknown>;
      v.audit = audit;
      expect(errorOf(stashTools, v), error).toContain(error);
    }
  });
});

