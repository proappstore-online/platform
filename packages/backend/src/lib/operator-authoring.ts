/**
 * Admin-console authoring, read-only (#295, Admin console T4): what an agent
 * needs to write an app's `operator_view` without guessing.
 *
 * - operatorCapabilities(): the kinds, formats, operations, limits and features
 *   the validator accepts, and a JSON Schema of `operator_view` built from the
 *   validator's own constants, so the two cannot drift.
 * - previewAdminConsole(): the real validator (validateOperatorView) on a
 *   proposal, plus a dry-run render — tabs, columns, actions, the role access
 *   matrix and the fields the sensitive-field list blocks (#294).
 * - inspectAdminConsole(): the stored contract against the app's current tools:
 *   the actions it references, the gaps (an action deleted or changed since the
 *   contract was registered) and what renders today.
 *
 * None of these reads app data: no data worker call, so no field value — secret
 * or not — can appear in their output.
 */
import { selectsColumn, actionCallers, type ToolManifest } from './action-sql.js';
import { validateOperatorView, MAX_ADMIN_ROLES, MAX_AUDIT_ROLES, MAX_OPERATOR_ACTIONS, MAX_OPERATOR_RESOURCES, OPERATOR_VIEW_VERSIONS, ROLE } from './operator-contract.js';
import { COLUMN_KEY, ID, MAX_OPERATOR_COLUMNS, OPERATOR_COLUMN_FORMATS, OPERATOR_RESOURCE_KINDS, isObj, type OperatorViewContract } from './operator-contract-shared.js';
import { LIST_CAPABILITIES, LIST_KINDS, MAX_DETAIL_FIELDS, MAX_EVIDENCE, MAX_PAGE_SIZE, MAX_STATES } from './operator-contract-lists.js';
import {
  MAX_DIMENSION_VALUES, MAX_MEASURES, MAX_SERIES_DAYS, MAX_SERIES_ROWS, SERIES_AGGREGATIONS, SERIES_GRAINS, SERIES_UNITS,
} from './operator-contract-series.js';
import { INTERNAL_FIELD_PREFIX, SENSITIVE_FIELD_COMPOUNDS, SENSITIVE_FIELD_TERMS, isSensitiveField, sensitiveMatch } from './sensitive-fields.js';

// ── The JSON Schema of operator_view ─────────────────────────────────────────

type Schema = Record<string, unknown>;
const str = (max: number): Schema => ({ type: 'string', minLength: 1, maxLength: max });
const name: Schema = { type: 'string', minLength: 1 };
const obj = (properties: Record<string, Schema>, required: string[]): Schema => ({ type: 'object', additionalProperties: false, properties, required });
const arr = (items: Schema, minItems: number, maxItems?: number): Schema => ({ type: 'array', items, minItems, ...(maxItems ? { maxItems } : {}) });
const int = (minimum: number, maximum: number): Schema => ({ type: 'integer', minimum, maximum });
const column: Schema = obj({ key: { type: 'string', pattern: COLUMN_KEY.source }, label: str(40), format: { enum: [...OPERATOR_COLUMN_FORMATS] } }, ['key', 'label']);
const roles = (max: number, never: string[]): Schema => arr({ type: 'string', pattern: ROLE.source, not: { enum: never } }, 1, max);

const resource: Schema = obj({
  id: { type: 'string', pattern: ID.source },
  kind: { enum: [...OPERATOR_RESOURCE_KINDS] },
  title: str(80),
  description: str(200),
  action: name,
  columns: arr(column, 1, MAX_OPERATOR_COLUMNS),
  search: obj({ param: name }, ['param']),
  page: obj({ param: name, column: name }, ['param', 'column']),
  status: obj({ column: name, states: arr(obj({ value: str(50), label: str(40) }, ['value', 'label']), 1, MAX_STATES), param: name }, ['column', 'states']),
  related: obj({ resource: name, param: name }, ['resource', 'param']),
  detail: obj({
    action: name, param: name, key: name,
    fields: arr(column, 1, MAX_DETAIL_FIELDS),
    evidence: arr(obj({ field: name, label: str(40) }, ['field', 'label']), 1, MAX_EVIDENCE),
  }, ['action', 'param', 'key', 'fields']),
  series: obj({
    time: obj({ column: name, grain: { enum: [...SERIES_GRAINS] } }, ['column', 'grain']),
    range: obj({ from_param: name, to_param: name, default_days: int(1, MAX_SERIES_DAYS), max_days: int(1, MAX_SERIES_DAYS) }, ['from_param', 'to_param', 'default_days', 'max_days']),
    measures: arr(obj({
      column: name, label: str(40), unit: { enum: [...SERIES_UNITS] }, currency: { type: 'string', pattern: '^[A-Z]{3}$' }, aggregation: { enum: [...SERIES_AGGREGATIONS] },
    }, ['column', 'label', 'unit', 'aggregation']), 1, MAX_MEASURES),
    dimension: obj({ column: name, label: str(40), max_values: int(1, MAX_DIMENSION_VALUES) }, ['column', 'label', 'max_values']),
  }, ['time', 'range', 'measures']),
}, ['id', 'kind', 'title', 'action', 'columns']);

const action: Schema = obj({
  id: { type: 'string', pattern: ID.source },
  title: str(40),
  resource: name,
  action: name,
  params: { type: 'object', additionalProperties: { type: 'string' } },
  confirm: str(200),
  transition: obj({ from: arr({ type: 'string' }, 1), to: { type: 'string' } }, ['from', 'to']),
  destructive: { type: 'boolean' },
  target: name,
}, ['id', 'title', 'resource', 'action', 'confirm']);

/**
 * The structure validateOperatorView accepts. It cannot express the rules that
 * need the app's tools (an action must exist, be role-gated and select the
 * declared columns…); operatorCapabilities().rules lists those in words, and
 * preview runs the real validator.
 */
export const OPERATOR_VIEW_SCHEMA: Schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'operator_view',
  ...obj({
    version: { enum: [...OPERATOR_VIEW_VERSIONS] },
    resources: arr(resource, 0, MAX_OPERATOR_RESOURCES),
    actions: arr(action, 0, MAX_OPERATOR_ACTIONS),
    audit: obj({ app_roles: roles(MAX_AUDIT_ROLES, ['member']) }, ['app_roles']),
    admin_access: obj({ roles: roles(MAX_ADMIN_ROLES, ['member', 'public']) }, ['roles']),
  }, ['version']),
};

export function operatorCapabilities() {
  return {
    version: OPERATOR_VIEW_VERSIONS[OPERATOR_VIEW_VERSIONS.length - 1],
    resource_kinds: [...OPERATOR_RESOURCE_KINDS],
    list_kinds: [...LIST_KINDS],
    column_formats: [...OPERATOR_COLUMN_FORMATS],
    action_operations: { resource: ['query'], detail: ['query'], action: ['execute', 'batch'] },
    limits: {
      resources: MAX_OPERATOR_RESOURCES, actions: MAX_OPERATOR_ACTIONS, columns: MAX_OPERATOR_COLUMNS, detail_fields: MAX_DETAIL_FIELDS,
      page_size: MAX_PAGE_SIZE, states: MAX_STATES, evidence: MAX_EVIDENCE, audit_roles: MAX_AUDIT_ROLES, admin_roles: MAX_ADMIN_ROLES,
      series_measures: MAX_MEASURES, series_dimension_values: MAX_DIMENSION_VALUES, series_days: MAX_SERIES_DAYS, series_rows: MAX_SERIES_ROWS,
    },
    features: {
      list_capabilities: [...LIST_CAPABILITIES],
      series: { grains: [...SERIES_GRAINS], units: [...SERIES_UNITS], aggregations: [...SERIES_AGGREGATIONS] },
      action_options: ['transition', 'destructive', 'target'],
      evidence: 'verification resources only: detail fields holding a _review/ document path',
      audit: 'audit.app_roles: the owner must also hold one to read the audit trail',
      admin_access: 'admin_access.roles: app roles admitted to the console beside the owner (never member or public)',
    },
    sensitive_fields: { terms: [...SENSITIVE_FIELD_TERMS], compounds: [...SENSITIVE_FIELD_COMPOUNDS], prefix: INTERNAL_FIELD_PREFIX },
    rules: [
      'Every referenced action must be a registered tool that requires sign-in, is not scheduled, and is gated by auth.app_roles (never member).',
      'A resource (and its detail) reads with a query action; a row action writes with an execute or batch action.',
      `A resource is called with no input; search, page, status and related are only on ${LIST_KINDS.join(', ')} resources; series only on metrics.`,
      "Columns and detail fields must be selected by their action's SQL, and none may match the sensitive-field list.",
      'A paged resource needs a literal LIMIT (the page size) and an ORDER BY; a series needs a literal LIMIT.',
      'Action params map action params to columns of their resource and cover every required param; a destructive action needs step_up.',
      'A transition maps a param to the status column and the write guards on it; verification decisions are step-up transitions taken on the record page.',
    ],
    schema: OPERATOR_VIEW_SCHEMA,
  };
}

// ── Render: what the console would show ──────────────────────────────────────

const toolNamed = (tools: ToolManifest[], name: string) => tools.find((t) => t.name === name);
const rolesOf = (tools: ToolManifest[], name: string) => toolNamed(tools, name)?.auth?.app_roles ?? [];

/** Tabs, columns, actions and the role access matrix of a contract. Blocked fields are named, never valued. */
export function renderAdminConsole(contract: OperatorViewContract, tools: ToolManifest[]) {
  const shown = (cols: { key: string; label: string; format: string }[]) => cols.filter((c) => !isSensitiveField(c.key));
  const blocked = (cols: { key: string }[]) => cols.filter((c) => isSensitiveField(c.key)).map((c) => c.key);
  const adminRoles = contract.admin_access?.roles ?? [];
  const resources = contract.resources.map((r) => ({
    id: r.id, title: r.title, kind: r.kind,
    read: { action: r.action, app_roles: rolesOf(tools, r.action) },
    detail: r.detail ? { action: r.detail.action, app_roles: rolesOf(tools, r.detail.action), step_up: r.detail.step_up } : null,
  }));
  const actions = contract.actions.map((a) => ({
    id: a.id, resource: a.resource, action: a.action, app_roles: rolesOf(tools, a.action), step_up: a.step_up, destructive: a.destructive ?? false,
  }));
  const allRoles = [...new Set([...adminRoles, ...resources.flatMap((r) => [...r.read.app_roles, ...(r.detail?.app_roles ?? [])]), ...actions.flatMap((a) => a.app_roles)])];
  return {
    tabs: contract.resources.map((r) => ({
      id: r.id, title: r.title, kind: r.kind,
      shows: r.series ? 'series' : r.kind === 'metrics' ? 'kpis' : 'table',
      columns: shown(r.columns).map(({ key, label, format }) => ({ key, label, format })),
      blocked_columns: blocked(r.columns),
      capabilities: LIST_CAPABILITIES.filter((k) => r[k]),
      detail: r.detail ? { fields: shown(r.detail.fields).map((f) => f.key), blocked_fields: blocked(r.detail.fields), evidence: (r.detail.evidence ?? []).map((e) => e.field) } : null,
      actions: contract.actions.filter((a) => a.resource === r.id).map((a) => a.id),
    })),
    actions: contract.actions.map((a) => ({
      id: a.id, title: a.title, resource: a.resource, confirm: a.confirm, destructive: a.destructive ?? false, step_up: a.step_up,
      transition: a.transition ?? null, target: a.target ?? null,
    })),
    access: {
      console: { owner: true, admin_roles: adminRoles },
      audit_trail: { owner_only: true, also_requires_one_of: contract.audit?.app_roles ?? [] },
      resources,
      actions,
      // What each role reaches. Entering the console needs the owner or an admin role;
      // each read and action then also needs that action's own role (and step_up where marked).
      by_role: allRoles.map((role) => ({
        role,
        admits_to_console: adminRoles.includes(role),
        reads: resources.filter((r) => r.read.app_roles.includes(role)).map((r) => r.id),
        details: resources.filter((r) => r.detail?.app_roles.includes(role)).map((r) => r.id),
        actions: actions.filter((a) => a.app_roles.includes(role)).map((a) => a.id),
      })),
    },
  };
}

// ── Preview: validate a proposal and render it ───────────────────────────────

/** Declared keys of a raw proposal that the sensitive-field list blocks — reported even when validation fails. */
function blockedFieldsOf(raw: unknown): { at: string; key: string; matched: string }[] {
  const out: { at: string; key: string; matched: string }[] = [];
  const resources = isObj(raw) && Array.isArray(raw.resources) ? raw.resources : [];
  const scan = (cols: unknown, at: string) => {
    if (!Array.isArray(cols)) return;
    cols.forEach((c, i) => {
      const key = isObj(c) && typeof c.key === 'string' ? c.key : null;
      const matched = key ? sensitiveMatch(key) : null;
      if (key && matched) out.push({ at: `${at}[${i}]`, key, matched });
    });
  };
  resources.forEach((r, i) => {
    if (!isObj(r)) return;
    scan(r.columns, `resources[${i}].columns`);
    if (isObj(r.detail)) scan(r.detail.fields, `resources[${i}].detail.fields`);
  });
  return out;
}

export function previewAdminConsole(tools: ToolManifest[], proposal: unknown) {
  const blocked_fields = blockedFieldsOf(proposal);
  const result = validateOperatorView(tools, proposal);
  if ('error' in result) return { valid: false, error: result.error, blocked_fields };
  if (!result.contract) return { valid: true, contract: null, blocked_fields, render: null, note: 'no operator_view: the console shows the platform baseline only' };
  return { valid: true, contract: result.contract, blocked_fields, render: renderAdminConsole(result.contract, tools) };
}

// ── Inspect: the stored contract against today's tools ──────────────────────

export interface AdminConsoleGap {
  code: 'action_missing' | 'wrong_operation' | 'not_role_gated' | 'public_action' | 'scheduled_action' | 'not_user_callable' | 'step_up_missing' | 'column_not_selected' | 'sensitive_field';
  where: string;
  detail: string;
}

export function inspectAdminConsole(contract: OperatorViewContract | null, tools: ToolManifest[]) {
  if (!contract) return { contract: null, actions: [], gaps: [], render: null, note: 'no operator_view registered: the console shows the platform baseline only' };
  const gaps: AdminConsoleGap[] = [];
  const referenced = new Set<string>();

  /** One referenced action: present, of the right operation, and still runnable from the console. */
  const check = (actionName: string, ops: string[], where: string, opts: { destructive?: boolean } = {}): ToolManifest | null => {
    referenced.add(actionName);
    const tool = toolNamed(tools, actionName);
    if (!tool) { gaps.push({ code: 'action_missing', where, detail: `action "${actionName}" is not registered` }); return null; }
    if (!ops.includes(tool.operation)) gaps.push({ code: 'wrong_operation', where, detail: `action "${actionName}" is a ${tool.operation}; expected ${ops.join(' or ')}` });
    if (tool.requires_auth === false) gaps.push({ code: 'public_action', where, detail: `action "${actionName}" no longer requires sign-in` });
    if (tool.schedule !== undefined) gaps.push({ code: 'scheduled_action', where, detail: `action "${actionName}" is scheduled` });
    const appRoles = tool.auth?.app_roles ?? [];
    if (appRoles.length === 0 || appRoles.includes('member')) gaps.push({ code: 'not_role_gated', where, detail: `action "${actionName}" is not gated by auth.app_roles (or allows member)` });
    if (!actionCallers(tool).includes('user')) gaps.push({ code: 'not_user_callable', where, detail: `action "${actionName}" does not list "user" in its callers, so the console cannot run it` });
    if (opts.destructive && tool.step_up !== true) gaps.push({ code: 'step_up_missing', where, detail: `destructive action "${actionName}" no longer declares step_up` });
    return tool;
  };
  const columns = (tool: ToolManifest | null, cols: { key: string }[], where: string) => {
    cols.forEach((c, i) => {
      if (isSensitiveField(c.key)) gaps.push({ code: 'sensitive_field', where: `${where}[${i}]`, detail: `"${c.key}" matches the sensitive-field list and is never returned` });
      else if (tool?.operation === 'query' && !selectsColumn(tool.sql ?? '', c.key)) gaps.push({ code: 'column_not_selected', where: `${where}[${i}]`, detail: `action "${tool.name}" no longer selects "${c.key}"` });
    });
  };

  const renders = contract.resources.map((r, i) => {
    const at = `resources[${i}]`;
    const before = gaps.length;
    const tool = check(r.action, ['query'], at);
    columns(tool, r.columns, `${at}.columns`);
    let detailOk: boolean | null = null;
    if (r.detail) {
      const mark = gaps.length;
      const detailTool = check(r.detail.action, ['query'], `${at}.detail`);
      columns(detailTool, r.detail.fields, `${at}.detail.fields`);
      detailOk = !gaps.slice(mark).some((g) => g.code !== 'sensitive_field' && g.code !== 'column_not_selected');
    }
    const broken = gaps.slice(before).some((g) => g.where === at);
    return { id: r.id, renders: !broken, detail_renders: detailOk };
  });
  contract.actions.forEach((a, i) => check(a.action, ['execute', 'batch'], `actions[${i}]`, { destructive: a.destructive === true }));

  return {
    contract,
    actions: [...referenced].map((n) => {
      const t = toolNamed(tools, n);
      return t
        ? { name: n, registered: true, operation: t.operation, params: Object.keys(t.params ?? {}), app_roles: t.auth?.app_roles ?? [], step_up: t.step_up === true, callers: actionCallers(t) }
        : { name: n, registered: false };
    }),
    gaps,
    resources: renders,
    render: renderAdminConsole(contract, tools),
  };
}
