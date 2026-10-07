/**
 * The operator-view contract (#240): how an app declares, in its mcp.json under
 * `operator_view`, the operator-relevant data and actions the Creator Console
 * renders for the app's owner — with no per-app console code.
 *
 *   "operator_view": {
 *     "version": 1,
 *     "resources": [{ "id", "kind", "title", "description"?, "action", "columns": [{ "key", "label", "format"? }],
 *                     users/reports/suspensions/verification only: "search"?, "page"?, "detail"?, "status"?, "related"?,
 *                     metrics only: "series"? }],
 *     "actions":   [{ "id", "title", "resource", "action", "params": { <action param>: <resource column> }, "confirm",
 *                     "transition"?: { "from": [<state>], "to": <state> }, "destructive"?: true, "target"?: <column> }],
 *     "audit"?:    { "app_roles": [<role>] }     // the owner must also hold one to read the audit trail
 *     "admin_access"?: { "roles": [<role>] }     // #302: who may use the admin console, beside the owner (enforced since #293)
 *   }
 *
 * A resource is a table (or, for `metrics`, one row of KPIs) read by one of the
 * app's registered query actions (list capabilities: operator-contract-lists.ts);
 * an action is a row action on a resource that runs one of its registered writes
 * with params taken from the row. Nothing here grants access: the owner-only
 * `/v1/apps/:appId/operator/*` routes run every read and write under the
 * action's own `auth.app_roles`, `step_up` and the success audit, exactly as the
 * actions route does, and return only the declared columns/fields.
 *
 * Validation is strict so the console can trust a stored contract: unknown
 * versions, kinds, fields and formats are rejected, and every referenced action
 * must be role-gated (never public, never the every-user `member` role, never a
 * scheduled action). Versioning is additive: a future version adds fields or
 * kinds; version 1 contracts keep validating and rendering as they are.
 */
import type { ToolManifest } from './action-sql.js';
import { resolveRelated, validateListCapabilities } from './operator-contract-lists.js';
import { validateSeries } from './operator-contract-series.js';
import {
  ID, OPERATOR_RESOURCE_KINDS, gatedTool, isObj, required, text, unknownField, validateColumns,
  type OperatorAction, type OperatorResource, type OperatorResourceKind, type OperatorViewContract,
} from './operator-contract-shared.js';

export type { OperatorResource, OperatorViewContract } from './operator-contract-shared.js';

const OPERATOR_VIEW_VERSIONS = [1] as const;
const MAX_OPERATOR_RESOURCES = 20;
const MAX_OPERATOR_ACTIONS = 20;
const MAX_AUDIT_ROLES = 5;
const MAX_ADMIN_ROLES = 5;
const ROLE = /^[a-z][a-z0-9_-]{0,49}$/;

const RESOURCE_FIELDS = ['id', 'kind', 'title', 'description', 'action', 'columns', 'search', 'page', 'detail', 'status', 'related', 'series'];
const ACTION_FIELDS = ['id', 'title', 'resource', 'action', 'params', 'confirm', 'transition', 'destructive', 'target'];

function validateResource(tools: ToolManifest[], raw: unknown, where: string): OperatorResource | string {
  if (!isObj(raw)) return `${where} must be an object`;
  const extra = unknownField(raw, RESOURCE_FIELDS, where);
  if (extra) return extra;
  if (typeof raw.id !== 'string' || !ID.test(raw.id)) return `${where}: id must match [a-z][a-z0-9_] (max 50 chars)`;
  if (!OPERATOR_RESOURCE_KINDS.includes(raw.kind as OperatorResourceKind)) {
    return `${where}: kind must be one of ${OPERATOR_RESOURCE_KINDS.join(', ')}`;
  }
  const title = text(raw.title, 80);
  if (!title) return `${where}: title is required (max 80 chars)`;
  const description = raw.description === undefined ? null : text(raw.description, 200);
  if (raw.description !== undefined && !description) return `${where}: description must be a non-empty string (max 200 chars)`;
  const tool = gatedTool(tools, raw.action, where);
  if (typeof tool === 'string') return tool;
  if (tool.operation !== 'query') return `${where}: action "${tool.name}" must be a query (resources are read-only; writes belong in actions)`;
  const needs = required(tool);
  if (needs.length) return `${where}: action "${tool.name}" has required params (${needs.join(', ')}); the console calls a resource with none`;

  const columns = validateColumns(tool, raw.columns, where);
  if (typeof columns === 'string') return columns;
  const lists = validateListCapabilities(tools, tool, columns, raw, where);
  if (typeof lists === 'string') return lists;
  let series: OperatorResource['series'] = null;
  if (raw.series !== undefined) {
    if (raw.kind !== 'metrics') return `${where}: series is only supported on metrics resources`;
    const s = validateSeries(tool, columns, raw.series, where);
    if (typeof s === 'string') return s;
    series = s;
  }
  // A KPI panel is an aggregate (#245): one row of numbers, never per-user rows
  // (PAS-AUTH-016: caller_unscoped only for aggregates that return no row data).
  // The route returns at most that one row, numbers only, whatever the query does.
  if (raw.kind === 'metrics' && !series) {
    const notNumber = columns.find((c) => c.format !== 'number');
    if (notNumber) return `${where}: column "${notNumber.key}" must have format "number" — a metrics resource without series is one row of aggregate numbers`;
  }
  return { id: raw.id, kind: raw.kind as OperatorResourceKind, title, description, action: tool.name, columns, ...lists, series };
}

/** Params come only from declared columns of the action's resource, and cover every required param. */
function mapParams(tool: ToolManifest, resource: OperatorResource, params: unknown, where: string): Record<string, string> | string {
  if (!isObj(params)) return `${where}: params must be an object of { action param: resource column }`;
  const mapped: Record<string, string> = {};
  for (const [param, column] of Object.entries(params)) {
    if (!tool.params?.[param]) return `${where}: action "${tool.name}" has no param "${param}"`;
    if (typeof column !== 'string' || !resource.columns.some((c) => c.key === column)) {
      return `${where}: params.${param} must name a column of resource "${resource.id}"`;
    }
    mapped[param] = column;
  }
  const unmapped = required(tool).filter((p) => !(p in mapped));
  if (unmapped.length) return `${where}: required params of "${tool.name}" are not mapped: ${unmapped.join(', ')}`;
  return mapped;
}

/**
 * A status transition is offered on rows whose status is in `from` — and the
 * app's own SQL must enforce it: one mapped param carries the row's current
 * status, and the write uses it (`... AND status = :from_status`). A stale or
 * forged status then changes nothing, which the platform answers with 409.
 */
function validateTransition(tool: ToolManifest, resource: OperatorResource, mapped: Record<string, string>, raw: unknown, where: string): NonNullable<OperatorAction['transition']> | string {
  const at = `${where}.transition`;
  if (!isObj(raw)) return `${at} must be an object`;
  const extra = unknownField(raw, ['from', 'to'], at);
  if (extra) return extra;
  const status = resource.status;
  if (!status) return `${at}: resource "${resource.id}" declares no status`;
  const states = status.states.map((s) => s.value);
  const from = raw.from;
  if (!Array.isArray(from) || from.length === 0 || from.some((s) => typeof s !== 'string' || !states.includes(s))) {
    return `${at}: from must be a non-empty list of declared states`;
  }
  if (typeof raw.to !== 'string' || !states.includes(raw.to)) return `${at}: to must be a declared state`;
  const guard = Object.entries(mapped).find(([, column]) => column === status.column)?.[0];
  const sql = [tool.sql ?? '', ...(tool.statements ?? [])].join('\n');
  if (!guard || !new RegExp(`:${guard}\\b`).test(sql)) {
    return `${at}: map a param of "${tool.name}" to the status column "${status.column}" and guard the write with it (e.g. AND status = :from_status)`;
  }
  return { from: from as string[], to: raw.to };
}

function validateAction(tools: ToolManifest[], resources: OperatorResource[], raw: unknown, where: string): OperatorAction | string {
  if (!isObj(raw)) return `${where} must be an object`;
  const extra = unknownField(raw, ACTION_FIELDS, where);
  if (extra) return extra;
  if (typeof raw.id !== 'string' || !ID.test(raw.id)) return `${where}: id must match [a-z][a-z0-9_] (max 50 chars)`;
  const title = text(raw.title, 40);
  if (!title) return `${where}: title is required (max 40 chars)`;
  const confirm = text(raw.confirm, 200);
  if (!confirm) return `${where}: confirm is required (the question the owner confirms, max 200 chars)`;
  const resource = resources.find((r) => r.id === raw.resource);
  if (!resource) return `${where}: resource must be the id of a declared resource`;
  const tool = gatedTool(tools, raw.action, where);
  if (typeof tool === 'string') return tool;
  if (tool.operation !== 'execute' && tool.operation !== 'batch') {
    return `${where}: action "${tool.name}" must be an execute or batch write (reads belong in resources)`;
  }
  const mapped = mapParams(tool, resource, raw.params ?? {}, where);
  if (typeof mapped === 'string') return mapped;

  const transition = raw.transition === undefined ? null : validateTransition(tool, resource, mapped, raw.transition, where);
  if (typeof transition === 'string') return transition;
  if (raw.destructive !== undefined && typeof raw.destructive !== 'boolean') return `${where}: destructive must be a boolean`;
  const destructive = raw.destructive === true;
  if (destructive && tool.step_up !== true) {
    return `${where}: destructive action "${tool.name}" must declare step_up, so it needs a recent sign-in`;
  }
  const target = raw.target ?? Object.values(mapped)[0] ?? null;
  if (target !== null && !resource.columns.some((c) => c.key === target)) return `${where}: target must be a declared column of resource "${resource.id}"`;
  return {
    id: raw.id, title, resource: resource.id, action: tool.name, params: mapped, confirm,
    step_up: tool.step_up === true, transition, destructive, target: target as string | null,
  };
}

/**
 * The identity-verification rules (#240): a verification queue is a status
 * workflow with a detail page, and every read of that page and every decision
 * needs a recent sign-in. Decisions are guarded transitions whose params (and
 * the status) are detail fields, so they can be taken on the record page after
 * the evidence has been looked at.
 */
function validateVerification(resources: OperatorResource[], actions: OperatorAction[]): string | null {
  for (const [i, r] of resources.entries()) {
    if (r.kind !== 'verification') continue;
    const at = `operator_view.resources[${i}]`;
    if (!r.status || !r.detail) return `${at}: a verification resource must declare status and detail`;
    if (!r.detail.step_up) return `${at}.detail: action "${r.detail.action}" must declare step_up (identity data needs a recent sign-in)`;
    const fields = new Set(r.detail.fields.map((f) => f.key));
    if (!fields.has(r.status.column)) return `${at}.detail: fields must include the status column "${r.status.column}"`;
    for (const [j, a] of actions.entries()) {
      if (a.resource !== r.id) continue;
      const aat = `operator_view.actions[${j}]`;
      if (!a.transition) return `${aat}: decisions on a verification resource must be status transitions`;
      if (!a.step_up) return `${aat}: action "${a.action}" must declare step_up (every verification decision needs a recent sign-in)`;
      const missing = [...Object.values(a.params), ...(a.target ? [a.target] : [])].find((col) => !fields.has(col));
      if (missing) return `${aat}: column "${missing}" must also be a detail field of "${r.id}" (decisions are taken on the record page)`;
    }
  }
  return null;
}

/** `audit: { app_roles }` — app roles, never the every-user `member`. */
function validateAudit(raw: unknown): { app_roles: string[] } | null | string {
  if (raw === undefined) return null;
  if (!isObj(raw)) return 'operator_view.audit must be an object';
  const extra = unknownField(raw, ['app_roles'], 'operator_view.audit');
  if (extra) return extra;
  const roles = raw.app_roles;
  if (!Array.isArray(roles) || roles.length === 0 || roles.length > MAX_AUDIT_ROLES || roles.some((r) => typeof r !== 'string' || !ROLE.test(r))) {
    return `operator_view.audit.app_roles must be 1-${MAX_AUDIT_ROLES} app role names`;
  }
  if (roles.includes('member')) return "operator_view.audit.app_roles cannot include 'member' (every signed-in user holds it)";
  return { app_roles: [...new Set(roles as string[])] };
}

/**
 * `admin_access: { roles }` (#291, #302): the app roles that may use the admin
 * console. Never `member` (every signed-in user holds it) or `public` (not a
 * role). Who may read the audit trail stays `audit.app_roles`; the design's
 * `audit_required_role` is refused rather than kept as a second field for it.
 */
function validateAdminAccess(raw: unknown): { roles: string[] } | null | string {
  if (raw === undefined) return null;
  if (!isObj(raw)) return 'operator_view.admin_access must be an object';
  if ('audit_required_role' in raw) {
    return 'operator_view.admin_access.audit_required_role is not supported: declare who may read the audit trail in operator_view.audit.app_roles';
  }
  const extra = unknownField(raw, ['roles'], 'operator_view.admin_access');
  if (extra) return extra;
  const roles = raw.roles;
  if (!Array.isArray(roles) || roles.length === 0 || roles.length > MAX_ADMIN_ROLES || roles.some((r) => typeof r !== 'string' || !ROLE.test(r))) {
    return `operator_view.admin_access.roles must be 1-${MAX_ADMIN_ROLES} app role names`;
  }
  if (roles.includes('member')) return "operator_view.admin_access.roles cannot include 'member' (every signed-in user holds it)";
  if (roles.includes('public')) return "operator_view.admin_access.roles cannot include 'public' (it is not a role; the admin console is never public)";
  return { roles: [...new Set(roles as string[])] };
}

/**
 * Validate `operator_view` against the app's (already validated) tools.
 * Absent or null is the baseline: `{ contract: null }`.
 */
export function validateOperatorView(tools: ToolManifest[], raw: unknown): { error: string } | { contract: OperatorViewContract | null } {
  if (raw === undefined || raw === null) return { contract: null };
  if (!isObj(raw)) return { error: 'operator_view must be an object' };
  const extra = unknownField(raw, ['version', 'resources', 'actions', 'audit', 'admin_access'], 'operator_view');
  if (extra) return { error: extra };
  if (!OPERATOR_VIEW_VERSIONS.includes(raw.version as 1)) {
    return { error: `operator_view.version must be one of ${OPERATOR_VIEW_VERSIONS.join(', ')}` };
  }
  const rawResources = raw.resources ?? [];
  const rawActions = raw.actions ?? [];
  if (!Array.isArray(rawResources) || rawResources.length > MAX_OPERATOR_RESOURCES) {
    return { error: `operator_view.resources must be an array of at most ${MAX_OPERATOR_RESOURCES}` };
  }
  if (!Array.isArray(rawActions) || rawActions.length > MAX_OPERATOR_ACTIONS) {
    return { error: `operator_view.actions must be an array of at most ${MAX_OPERATOR_ACTIONS}` };
  }

  const ids = new Set<string>();
  const resources: OperatorResource[] = [];
  for (const [i, r] of rawResources.entries()) {
    const result = validateResource(tools, r, `operator_view.resources[${i}]`);
    if (typeof result === 'string') return { error: result };
    if (ids.has(result.id)) return { error: `operator_view.resources[${i}]: duplicate id "${result.id}"` };
    ids.add(result.id);
    resources.push(result);
  }
  const related = resolveRelated(resources);
  if (related) return { error: related };
  const actions: OperatorAction[] = [];
  for (const [i, a] of rawActions.entries()) {
    const result = validateAction(tools, resources, a, `operator_view.actions[${i}]`);
    if (typeof result === 'string') return { error: result };
    if (ids.has(result.id)) return { error: `operator_view.actions[${i}]: duplicate id "${result.id}"` };
    ids.add(result.id);
    actions.push(result);
  }
  const verification = validateVerification(resources, actions);
  if (verification) return { error: verification };
  const audit = validateAudit(raw.audit);
  if (typeof audit === 'string') return { error: audit };
  const adminAccess = validateAdminAccess(raw.admin_access);
  if (typeof adminAccess === 'string') return { error: adminAccess };
  // Absent stays absent, so a contract without it stores exactly as before.
  return { contract: { version: 1, resources, actions, audit, ...(adminAccess ? { admin_access: adminAccess } : {}) } };
}
