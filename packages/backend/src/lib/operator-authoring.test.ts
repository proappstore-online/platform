import { describe, expect, it } from 'vitest';
import { inspectAdminConsole, operatorCapabilities, OPERATOR_VIEW_SCHEMA, previewAdminConsole, proposeAdminUpdate, securityReview, writeKind } from './operator-authoring.js';
import { validateOperatorView } from './operator-contract.js';
import { schemaViolations } from './json-schema-check.js';
import type { ToolManifest } from './action-sql.js';
import { PARENTS_CLUBS, STASH } from '../__fixtures__/operator-view.js';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const stashTools = STASH.tools as ToolManifest[];
const contractOf = (tools: ToolManifest[], view: unknown) => {
  const r = validateOperatorView(tools, view);
  if (!('contract' in r) || !r.contract) throw new Error('error' in r ? r.error : 'no contract');
  return r.contract;
};

describe('list_admin_capabilities schema matches the validator (#295)', () => {
  const accepted: [string, ToolManifest[], unknown][] = [
    ['stash', stashTools, STASH.operator_view],
    ['parents-clubs', PARENTS_CLUBS.tools as ToolManifest[], PARENTS_CLUBS.operator_view],
    ['stash + admin_access + audit', stashTools, { ...STASH.operator_view, admin_access: { roles: ['operator', 'support'] }, audit: { app_roles: ['operator'] } }],
  ];
  for (const [label, tools, view] of accepted) {
    it(`accepts what the validator accepts: ${label}`, () => {
      expect(validateOperatorView(tools, view)).toHaveProperty('contract');
      expect(schemaViolations(OPERATOR_VIEW_SCHEMA, view)).toEqual([]);
    });
  }

  const v = () => clone(STASH.operator_view) as Record<string, any>;
  const rejected: [string, (x: Record<string, any>) => void][] = [
    ['an unknown top-level field', (x) => { x.extra = 1; }],
    ['version 2', (x) => { x.version = 2; }],
    ['an unknown resource field', (x) => { x.resources[0].colour = 'red'; }],
    ['an unknown action field', (x) => { x.actions[0].extra = true; }],
    ['an unknown column field', (x) => { x.resources[0].columns[0].width = 10; }],
    ['an unknown kind', (x) => { x.resources[0].kind = 'orders'; }],
    ['an unknown column format', (x) => { x.resources[0].columns[0].format = 'money'; }],
    ['a bad resource id', (x) => { x.resources[0].id = 'Members'; }],
    ['no columns', (x) => { x.resources[0].columns = []; }],
    ['21 resources', (x) => { x.resources = Array.from({ length: 21 }, () => x.resources[0]); }],
    ['21 actions', (x) => { x.actions = Array.from({ length: 21 }, () => x.actions[0]); }],
    ['an unknown detail field', (x) => { x.resources[0].detail.extra = 1; }],
    ['an unknown series grain', (x) => { x.resources.find((r: any) => r.series).series.time.grain = 'hour'; }],
    ['an unknown measure unit', (x) => { x.resources.find((r: any) => r.series).series.measures[0].unit = 'parsecs'; }],
    ['admin_access with member', (x) => { x.admin_access = { roles: ['member'] }; }],
    ['admin_access with public', (x) => { x.admin_access = { roles: ['public'] }; }],
    ['admin_access with audit_required_role', (x) => { x.admin_access = { roles: ['operator'], audit_required_role: 'operator' }; }],
    ['admin_access with six roles', (x) => { x.admin_access = { roles: ['a', 'b', 'c', 'd', 'e', 'f'] }; }],
    ['audit with member', (x) => { x.audit = { app_roles: ['member'] }; }],
  ];
  for (const [label, mutate] of rejected) {
    it(`rejects what the validator rejects: ${label}`, () => {
      const view = v();
      mutate(view);
      expect(validateOperatorView(stashTools, view)).toHaveProperty('error');
      expect(schemaViolations(OPERATOR_VIEW_SCHEMA, view)).not.toEqual([]);
    });
  }

  it('reports the limits, kinds, formats and operations, and a schema that includes admin_access', () => {
    const caps = operatorCapabilities();
    expect(caps.limits).toMatchObject({ resources: 20, actions: 20 });
    expect(caps.resource_kinds).toEqual(['users', 'reports', 'suspensions', 'verification', 'metrics']);
    expect(caps.action_operations).toEqual({ resource: ['query'], detail: ['query'], action: ['execute', 'batch'] });
    expect((caps.schema.properties as Record<string, unknown>).admin_access).toBeDefined();
    expect(caps.sensitive_fields.prefix).toBe('_internal');
  });
});

describe('inspect_admin_console (#295)', () => {
  const contract = contractOf(stashTools, STASH.operator_view);

  it('a contract whose actions all still exist has no gaps and renders every resource', () => {
    const r = inspectAdminConsole(contract, stashTools);
    expect(r.gaps).toEqual([]);
    expect(r.resources.every((x) => x.renders)).toBe(true);
    expect(r.actions.find((a) => a.name === 'op_list_users')).toMatchObject({ registered: true, operation: 'query', app_roles: ['operator'] });
  });

  it('flags a missing action and a wrong-operation action, and the resources they break', () => {
    const tools = clone(stashTools)
      .filter((t) => t.name !== 'op_list_users')
      .map((t) => (t.name === 'op_suspend_user' ? { ...t, operation: 'query' as const, sql: 'SELECT 1 AS x', statements: undefined } : t)) as ToolManifest[];
    const r = inspectAdminConsole(contract, tools);
    expect(r.gaps).toEqual(expect.arrayContaining([
      { code: 'action_missing', where: 'resources[0]', detail: 'action "op_list_users" is not registered' },
      expect.objectContaining({ code: 'wrong_operation', detail: expect.stringContaining('"op_suspend_user" is a query; expected execute or batch') }),
    ]));
    expect(r.resources[0]).toMatchObject({ id: 'members', renders: false });
    expect(r.actions.find((a) => a.name === 'op_list_users')).toEqual({ name: 'op_list_users', registered: false });
  });

  it('flags actions the console can no longer run, columns no longer selected, and sensitive columns', () => {
    const tools = clone(stashTools).map((t) => {
      if (t.name === 'op_list_kyc') return { ...t, callers: ['worker'] };
      if (t.name === 'op_list_users') return { ...t, sql: t.sql!.replace(/\bdisplay_name\b/g, 'nick') };
      if (t.name === 'op_report_metrics') return { ...t, auth: { ...t.auth, app_roles: [] } };
      return t;
    }) as ToolManifest[];
    const legacy = clone(contract);
    legacy.resources[0]!.columns.push({ key: 'api_key', label: 'Key', format: 'text' });
    const codes = inspectAdminConsole(legacy, tools).gaps.map((g) => g.code);
    expect(codes).toEqual(expect.arrayContaining(['not_user_callable', 'column_not_selected', 'not_role_gated', 'sensitive_field']));
  });

  it('no contract: the baseline', () => {
    expect(inspectAdminConsole(null, stashTools)).toMatchObject({ contract: null, gaps: [], render: null });
  });
});

describe('preview_admin_console (#295)', () => {
  it('renders tabs, columns, actions and the role access matrix of a valid proposal', () => {
    const p = previewAdminConsole(stashTools, { ...STASH.operator_view, admin_access: { roles: ['support'] } });
    expect(p.valid).toBe(true);
    if (!p.valid || !p.render) throw new Error('expected a render');
    const members = p.render.tabs.find((t) => t.id === 'members')!;
    expect(members).toMatchObject({ shows: 'table', capabilities: expect.arrayContaining(['search', 'page', 'detail']), blocked_columns: [] });
    expect(members.columns.map((c) => c.key)).toEqual(['display_name', 'user_id', 'created_at', 'suspended']);
    expect(p.render.actions.find((a) => a.id === 'suspend_member')).toMatchObject({ destructive: true, step_up: true });
    expect(p.render.access.console).toEqual({ owner: true, admin_roles: ['support'] });
    expect(p.render.access.by_role).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'support', admits_to_console: true, reads: [], actions: [] }),
      expect.objectContaining({ role: 'operator', admits_to_console: false, reads: expect.arrayContaining(['members']) }),
    ]));
  });

  it("returns the validator's own error for an invalid proposal", () => {
    const bad = clone(STASH.operator_view) as Record<string, any>;
    bad.resources[0].action = 'op_nope';
    expect(previewAdminConsole(stashTools, bad)).toEqual({
      valid: false, error: 'operator_view.resources[0]: action "op_nope" is not a tool in this manifest', blocked_fields: [],
    });
  });

  it('names the fields the sensitive-field list blocks, never a value', () => {
    const bad = clone(STASH.operator_view) as Record<string, any>;
    bad.resources[0].columns.push({ key: 'password_hash', label: 'Hash' });
    bad.resources[0].detail.fields.push({ key: '_internal_score', label: 'Score' });
    const p = previewAdminConsole(stashTools, bad);
    expect(p.valid).toBe(false);
    expect(p.blocked_fields).toEqual([
      { at: 'resources[0].columns[4]', key: 'password_hash', matched: 'password' },
      { at: 'resources[0].detail.fields[5]', key: '_internal_score', matched: '_internal' },
    ]);
  });

  it('no operator_view: valid, the baseline', () => {
    expect(previewAdminConsole(stashTools, null)).toMatchObject({ valid: true, contract: null, render: null });
  });
});

// ── #296: security review and propose ───────────────────────────────────────

const roles = (granted: string[], ownerHolds: string[] = []) => ({ granted: new Set(granted), ownerHolds: new Set(ownerHolds) });
const codes = (issues: { code: string; severity: string }[], severity?: string) => issues.filter((i) => !severity || i.severity === severity).map((i) => i.code);

describe('validate_admin_security (#296)', () => {
  it('passes both sample apps', () => {
    expect(securityReview(stashTools, STASH.operator_view, roles(['operator', 'reviewer'], ['operator']))).toEqual({ passes_security_gates: true, issues: [] });
    expect(securityReview(PARENTS_CLUBS.tools as ToolManifest[], PARENTS_CLUBS.operator_view).passes_security_gates).toBe(true);
  });

  it('flags a declared secret column and a destructive action without step_up, and fails the gate', () => {
    const view = clone(STASH.operator_view) as Record<string, any>;
    view.resources[0].columns.push({ key: 'api_key', label: 'Key' });
    const tools = clone(stashTools).map((t) => (t.name === 'op_suspend_user' ? { ...t, step_up: false } : t)) as ToolManifest[];
    const r = securityReview(tools, view);
    expect(r.passes_security_gates).toBe(false);
    expect(r.issues).toEqual(expect.arrayContaining([
      { path: 'operator_view.resources[0].columns[4]', code: 'secret_exposure', severity: 'error', message: expect.stringContaining('"api_key"') },
      { path: 'operator_view.actions[0].destructive', code: 'destructive_without_step_up', severity: 'error', message: expect.stringContaining('op_suspend_user') },
    ]));
  });

  it('flags missing actions and a write no row param scopes', () => {
    const view = clone(STASH.operator_view) as Record<string, any>;
    view.resources[0].action = 'op_gone';
    const tools = clone(stashTools).map((t) => (t.name === 'op_lift_suspension' ? { ...t, statements: ["UPDATE members SET suspended = 0 WHERE suspended = 1", ...t.statements!.slice(1)] } : t)) as ToolManifest[];
    const lift = view.actions.findIndex((a: any) => a.action === 'op_lift_suspension');
    const r = securityReview(tools, view);
    expect(r.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'operator_view.resources[0].action', code: 'missing_action', severity: 'error' }),
      expect.objectContaining({ path: `operator_view.actions[${lift}].params`, code: 'unscoped_write', severity: 'error' }),
    ]));
  });

  // #339: a write must be scoped by a param mapped from the row's key, in its WHERE clause.
  it('classifies writes past comments and WITH, including REPLACE and upserts (#339)', () => {
    expect([
      'UPDATE t SET a = 1 WHERE id = :id',
      'DELETE FROM t WHERE id = :id',
      "-- close it\nUPDATE t SET s = 'x'",
      '/* tidy */ DELETE FROM t',
      'WITH old AS (SELECT id FROM t WHERE s = 1) UPDATE t SET s = 2 WHERE id IN (SELECT id FROM old)',
      'REPLACE INTO t (id, s) VALUES (:id, 1)',
      'INSERT OR REPLACE INTO t (id, s) VALUES (:id, 1)',
      'INSERT INTO t (id, s) VALUES (:id, 1) ON CONFLICT (id) DO UPDATE SET s = excluded.s',
      "INSERT INTO t (id, note) VALUES (:id, 'update me')",
      'SELECT id FROM t WHERE note = \'DELETE\'',
    ].map(writeKind)).toEqual(['update', 'delete', 'update', 'delete', 'update', 'replace', 'replace', 'upsert', 'insert', null]);
  });

  it('refuses writes not scoped to the row, and keeps keyed writes (#339)', () => {
    const resolve = STASH.operator_view.actions.findIndex((a) => a.action === 'op_resolve_report');
    const review = (sql: string) => {
      const tools = clone(stashTools).map((t) => (t.name === 'op_resolve_report' ? { ...t, sql } : t)) as ToolManifest[];
      return securityReview(tools, STASH.operator_view).issues.filter((i) => i.path === `operator_view.actions[${resolve}].params`).map((i) => i.code);
    };
    // The issue's example: the status guard is the only param, so every report in that status closes.
    for (const sql of [
      "UPDATE reports SET status = 'resolved' WHERE status = :from_status",
      "UPDATE reports SET reviewer_id = :report_id WHERE status = 'open'", // the key only in SET
      "UPDATE reports SET status = 'resolved' WHERE id != :report_id AND status = :from_status",
      "UPDATE reports SET status = 'resolved' WHERE id = :report_id OR status = :from_status",
      "-- close\nUPDATE reports SET status = 'resolved'", // comment-prefixed, no WHERE at all
      "REPLACE INTO reports (status) VALUES ('resolved')",
      "INSERT INTO reports (id, status) VALUES (:from_status, 'resolved') ON CONFLICT (id) DO UPDATE SET status = excluded.status",
    ]) expect(review(sql), sql).toEqual(['unscoped_write']);
    for (const sql of [
      "UPDATE reports SET status = 'resolved', reviewer_id = :__user_id WHERE id = :report_id AND status = :from_status",
      "UPDATE reports SET status = 'resolved' WHERE id IN (:report_id) AND status = :from_status",
      "/* keyed */ UPDATE reports SET status = (SELECT 'resolved' WHERE 1 = 1) WHERE :report_id = id AND status = :from_status",
      "INSERT INTO reports (id, status) VALUES (:report_id, 'resolved') ON CONFLICT (id) DO UPDATE SET status = excluded.status",
      "INSERT INTO report_notes (report_id, note) VALUES (:report_id, 'resolved')",
    ]) expect(review(sql), sql).toEqual([]);
  });

  it('warns on row-scoping smells in the referenced SQL', () => {
    const tools = clone(stashTools).map((t) => {
      if (t.name === 'op_list_users') return { ...t, sql: 'SELECT * FROM members m WHERE m.owner = :__user_id ORDER BY m.id' };
      return t;
    }) as ToolManifest[];
    expect(codes(securityReview(tools, STASH.operator_view).issues, 'warning')).toEqual(expect.arrayContaining(['select_star', 'caller_scoped_read', 'unbounded_read']));
  });

  it('checks audit and admin roles: member is an error; undefined, unheld and powerless roles are warnings', () => {
    const view = { ...clone(STASH.operator_view), audit: { app_roles: ['auditor'] }, admin_access: { roles: ['member', 'helpdesk', 'operator'] } };
    const r = securityReview(stashTools, view, roles(['operator', 'helpdesk']));
    expect(r.passes_security_gates).toBe(false);
    expect(r.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'operator_view.admin_access.roles', code: 'admin_role_error', severity: 'error' }),
      expect.objectContaining({ path: 'operator_view.audit.app_roles', code: 'undefined_role', severity: 'warning', message: expect.stringContaining('"auditor"') }),
      expect.objectContaining({ code: 'audit_role_unheld', severity: 'warning' }),
      expect.objectContaining({ code: 'admin_role_grants_nothing', severity: 'warning', message: expect.stringContaining('"helpdesk"') }),
    ]));
    // operator is held and used: no warning names it.
    expect(r.issues.some((i) => i.message.includes('"operator"'))).toBe(false);
  });

  it('withActions false skips the checks that need the tools', () => {
    const view = clone(STASH.operator_view) as Record<string, any>;
    view.resources[0].action = 'op_gone';
    expect(codes(securityReview([], view, undefined, { withActions: false }).issues)).not.toContain('missing_action');
  });
});

describe('propose_admin_update agrees with the backend validator (#296)', () => {
  for (const [label, tools, view] of [
    ['stash', stashTools, STASH.operator_view],
    ['parents-clubs', PARENTS_CLUBS.tools as ToolManifest[], PARENTS_CLUBS.operator_view],
  ] as const) {
    it(`valid where the validator accepts, with the same contract: ${label}`, () => {
      const p = proposeAdminUpdate(tools as ToolManifest[], view);
      expect(p.valid).toBe(true);
      expect(p.errors).toEqual([]);
      expect(p.contract).toEqual(contractOf(tools as ToolManifest[], view));
    });
  }

  const v = () => clone(STASH.operator_view) as Record<string, any>;
  for (const [label, mutate] of [
    ['an unknown action', (x: Record<string, any>) => { x.resources[0].action = 'op_nope'; }],
    ['a write as a resource', (x: Record<string, any>) => { x.resources[0].action = 'op_suspend_user'; }],
    ['an undeclared column', (x: Record<string, any>) => { x.resources[0].columns.push({ key: 'nickname', label: 'Nick' }); }],
    ['a secret column', (x: Record<string, any>) => { x.resources[0].columns.push({ key: 'api_key', label: 'Key' }); }],
    ['an unknown field', (x: Record<string, any>) => { x.colour = 'red'; }],
    ['admin_access with member', (x: Record<string, any>) => { x.admin_access = { roles: ['member'] }; }],
  ] as const) {
    it(`invalid where the validator refuses, with its error at its path: ${label}`, () => {
      const view = v();
      mutate(view);
      const r = validateOperatorView(stashTools, view);
      if (!('error' in r)) throw new Error('the validator accepted it');
      const p = proposeAdminUpdate(stashTools, view);
      expect(p.valid).toBe(false);
      expect(p.contract).toBeNull();
      const path = /^(operator_view(?:\.[A-Za-z_]+|\[\d+\])*)/.exec(r.error)![1];
      expect(p.errors.some((e) => e.path === path)).toBe(true);
    });
  }

  it('returns every structural error at once, each with a path', () => {
    const view = v();
    view.resources[0].kind = 'orders';
    view.resources[1].columns[0].format = 'money';
    view.version = 2;
    const paths = proposeAdminUpdate(stashTools, view).errors.map((e) => e.path);
    expect(paths).toEqual(expect.arrayContaining(['operator_view.version', 'operator_view.resources[0].kind', 'operator_view.resources[1].columns[0].format']));
  });

  it('lists every missing action and unselected column as missing requirements', () => {
    const view = v();
    view.resources[0].action = 'op_gone';
    view.actions[0].action = 'op_also_gone';
    view.resources[1].columns.push({ key: 'nickname', label: 'Nick' });
    const missing = proposeAdminUpdate(stashTools, view).missing_requirements.map((m) => m.path);
    expect(missing).toEqual(expect.arrayContaining(['operator_view.resources[0].action', 'operator_view.actions[0].action', `operator_view.resources[1].columns[${view.resources[1].columns.length - 1}]`]));
  });

  it('validateAgainstActions false checks the structure only, and says so', () => {
    const view = v();
    view.resources[0].action = 'op_gone';
    const p = proposeAdminUpdate([], view, { validateAgainstActions: false });
    expect(p.valid).toBe(true);
    expect(p.warnings[0]!.message).toContain('action checks skipped');
    view.colour = 'red';
    expect(proposeAdminUpdate([], view, { validateAgainstActions: false }).valid).toBe(false);
  });
});
