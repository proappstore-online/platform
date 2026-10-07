import { describe, expect, it } from 'vitest';
import { inspectAdminConsole, operatorCapabilities, OPERATOR_VIEW_SCHEMA, previewAdminConsole } from './operator-authoring.js';
import { validateOperatorView } from './operator-contract.js';
import type { ToolManifest } from './action-sql.js';
import { PARENTS_CLUBS, STASH } from '../__fixtures__/operator-view.js';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const stashTools = STASH.tools as ToolManifest[];
const contractOf = (tools: ToolManifest[], view: unknown) => {
  const r = validateOperatorView(tools, view);
  if (!('contract' in r) || !r.contract) throw new Error('error' in r ? r.error : 'no contract');
  return r.contract;
};

/** A minimal JSON Schema checker for the keywords OPERATOR_VIEW_SCHEMA uses. Returns the first violation, or null. */
type S = Record<string, unknown>;
function violation(schema: S, value: unknown, at = '$'): string | null {
  if (schema.enum && !(schema.enum as unknown[]).includes(value)) return `${at}: not in enum`;
  if (schema.not && (schema.not as S).enum && ((schema.not as S).enum as unknown[]).includes(value)) return `${at}: forbidden value`;
  const type = schema.type as string | undefined;
  if (type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return `${at}: not an object`;
    const props = (schema.properties ?? {}) as Record<string, S>;
    for (const r of (schema.required ?? []) as string[]) if (!(r in value)) return `${at}: missing ${r}`;
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) { const e = violation(props[k]!, v, `${at}.${k}`); if (e) return e; }
      else if (schema.additionalProperties === false) return `${at}: unknown ${k}`;
      else if (typeof schema.additionalProperties === 'object') { const e = violation(schema.additionalProperties as S, v, `${at}.${k}`); if (e) return e; }
    }
  } else if (type === 'array') {
    if (!Array.isArray(value)) return `${at}: not an array`;
    if (schema.minItems !== undefined && value.length < (schema.minItems as number)) return `${at}: too few`;
    if (schema.maxItems !== undefined && value.length > (schema.maxItems as number)) return `${at}: too many`;
    for (const [i, v] of value.entries()) { const e = violation(schema.items as S, v, `${at}[${i}]`); if (e) return e; }
  } else if (type === 'string') {
    if (typeof value !== 'string') return `${at}: not a string`;
    if (schema.minLength !== undefined && value.length < (schema.minLength as number)) return `${at}: too short`;
    if (schema.maxLength !== undefined && value.length > (schema.maxLength as number)) return `${at}: too long`;
    if (schema.pattern && !new RegExp(schema.pattern as string).test(value)) return `${at}: pattern`;
  } else if (type === 'integer') {
    if (!Number.isInteger(value)) return `${at}: not an integer`;
    if ((value as number) < (schema.minimum as number) || (value as number) > (schema.maximum as number)) return `${at}: out of range`;
  } else if (type === 'boolean' && typeof value !== 'boolean') return `${at}: not a boolean`;
  return null;
}

describe('list_admin_capabilities schema matches the validator (#295)', () => {
  const accepted: [string, ToolManifest[], unknown][] = [
    ['stash', stashTools, STASH.operator_view],
    ['parents-clubs', PARENTS_CLUBS.tools as ToolManifest[], PARENTS_CLUBS.operator_view],
    ['stash + admin_access + audit', stashTools, { ...STASH.operator_view, admin_access: { roles: ['operator', 'support'] }, audit: { app_roles: ['operator'] } }],
  ];
  for (const [label, tools, view] of accepted) {
    it(`accepts what the validator accepts: ${label}`, () => {
      expect(validateOperatorView(tools, view)).toHaveProperty('contract');
      expect(violation(OPERATOR_VIEW_SCHEMA, view)).toBeNull();
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
      expect(violation(OPERATOR_VIEW_SCHEMA, view)).not.toBeNull();
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
