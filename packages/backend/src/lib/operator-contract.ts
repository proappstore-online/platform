/**
 * The operator-view contract (#240, child 2): how an app declares, in its
 * mcp.json under `operator_view`, the operator-relevant data and actions the
 * Creator Console renders for the app's owner — with no per-app console code.
 *
 *   "operator_view": {
 *     "version": 1,
 *     "resources": [{ "id", "kind", "title", "description"?, "action", "columns": [{ "key", "label", "format"? }],
 *                     users only (#240 slice 3): "search"?: { "param" }, "page"?: { "param", "column" },
 *                     "detail"?: { "action", "param", "key", "fields": [{ "key", "label", "format"? }] } }],
 *     "actions":   [{ "id", "title", "resource", "action", "params": { <action param>: <resource column> }, "confirm" }]
 *   }
 *
 * A resource is a table (or, for `metrics`, one row of KPIs) read by one of the
 * app's registered query actions; an action is a row action on a resource that
 * runs one of its registered write actions with params taken from the row.
 * Nothing here grants access. Reads run through the owner-only
 * `/v1/apps/:appId/operator/resources/*` routes, which apply the action's
 * `auth.app_roles`, `step_up` and the #232 audit exactly as the actions route
 * does and return only the declared columns/fields; writes run through the
 * ordinary `/v1/apps/:appId/actions/:name` route.
 *
 * Validation is strict so the console can trust a stored contract: unknown
 * versions, kinds, fields and formats are rejected, and every referenced action
 * must be role-gated (never public, never the every-user `member` role, never a
 * scheduled action). Versioning is additive: a future version adds fields or
 * kinds; version 1 contracts keep validating and rendering as they are.
 */
import { literalLimit, selectsColumn, type ToolManifest } from './action-sql.js';

const OPERATOR_VIEW_VERSIONS = [1] as const;
const OPERATOR_RESOURCE_KINDS = ['users', 'reports', 'suspensions', 'verification', 'metrics'] as const;
const OPERATOR_COLUMN_FORMATS = ['text', 'number', 'datetime', 'boolean', 'badge'] as const;
const MAX_OPERATOR_RESOURCES = 20;
const MAX_OPERATOR_ACTIONS = 20;
const MAX_OPERATOR_COLUMNS = 12;
const MAX_OPERATOR_DETAIL_FIELDS = 24;
const MAX_OPERATOR_PAGE_SIZE = 200; // a paged resource's page size is its query's literal LIMIT

type OperatorResourceKind = (typeof OPERATOR_RESOURCE_KINDS)[number];
type OperatorColumnFormat = (typeof OPERATOR_COLUMN_FORMATS)[number];

interface OperatorColumn { key: string; label: string; format: OperatorColumnFormat }

/** Per-record read of a users resource: `action` runs with `param` = the row's `key` column. */
interface OperatorDetail { action: string; param: string; key: string; fields: OperatorColumn[]; step_up: boolean }

export interface OperatorResource {
  id: string;
  kind: OperatorResourceKind;
  title: string;
  description: string | null;
  action: string;
  columns: OperatorColumn[];
  /** Users only: the action param that receives the search text. Absent on contracts stored before slice 3. */
  search?: { param: string } | null;
  /** Users only: keyset paging. `param` receives the last row's `column`; `size` is the query's literal LIMIT. */
  page?: { param: string; column: string; size: number } | null;
  detail?: OperatorDetail | null;
}

interface OperatorAction {
  id: string;
  title: string;
  resource: string;
  action: string;
  params: Record<string, string>;
  confirm: string;
  /** Copied from the action's manifest, so the console can say a re-auth is needed before it asks. */
  step_up: boolean;
}

export interface OperatorViewContract {
  version: 1;
  resources: OperatorResource[];
  actions: OperatorAction[];
}

const ID = /^[a-z][a-z0-9_]{0,49}$/;
const COLUMN_KEY = /^[a-z_][a-z0-9_]{0,49}$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function unknownField(value: Obj, allowed: readonly string[], where: string): string | null {
  const extra = Object.keys(value).find((k) => !allowed.includes(k));
  return extra === undefined ? null : `${where}: unknown field "${extra}"`;
}

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : null;
}

/** The referenced tool, or why it may not back an operator resource/action. */
function gatedTool(tools: ToolManifest[], name: unknown, where: string): ToolManifest | string {
  if (typeof name !== 'string' || !name) return `${where}: action is required`;
  const tool = tools.find((t) => t.name === name);
  if (!tool) return `${where}: action "${name}" is not a tool in this manifest`;
  if (tool.requires_auth === false) return `${where}: action "${name}" is public; operator data and actions must require sign-in`;
  if (tool.schedule !== undefined) return `${where}: action "${name}" is scheduled and takes no caller input`;
  const roles = tool.auth?.app_roles ?? [];
  if (roles.length === 0 || roles.includes('member')) {
    return `${where}: action "${name}" must be gated by auth.app_roles (not 'member'), so it is never open to every signed-in user`;
  }
  return tool;
}

const required = (tool: ToolManifest) =>
  Object.entries(tool.params ?? {}).filter(([, p]) => !p.optional && p.default === undefined).map(([k]) => k);

function validateColumns(tool: ToolManifest, value: unknown, where: string, name = 'columns', max = MAX_OPERATOR_COLUMNS): OperatorColumn[] | string {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) {
    return `${where}: ${name} must be an array of 1-${max}`;
  }
  const columns: OperatorColumn[] = [];
  for (const [i, col] of value.entries()) {
    const at = `${where}.${name}[${i}]`;
    if (!isObj(col)) return `${at} must be an object`;
    const colExtra = unknownField(col, ['key', 'label', 'format'], at);
    if (colExtra) return colExtra;
    if (typeof col.key !== 'string' || !COLUMN_KEY.test(col.key)) return `${at}: key must match [a-z_][a-z0-9_] (max 50 chars)`;
    if (columns.some((c) => c.key === col.key)) return `${at}: duplicate column "${col.key}"`;
    if (!selectsColumn(tool.sql ?? '', col.key)) return `${at}: action "${tool.name}" does not select column "${col.key}"`;
    const label = text(col.label, 40);
    if (!label) return `${at}: label is required (max 40 chars)`;
    const format = col.format ?? 'text';
    if (!OPERATOR_COLUMN_FORMATS.includes(format as OperatorColumnFormat)) {
      return `${at}: format must be one of ${OPERATOR_COLUMN_FORMATS.join(', ')}`;
    }
    columns.push({ key: col.key, label, format: format as OperatorColumnFormat });
  }
  return columns;
}

function validateResource(tools: ToolManifest[], raw: unknown, where: string): OperatorResource | string {
  if (!isObj(raw)) return `${where} must be an object`;
  const extra = unknownField(raw, ['id', 'kind', 'title', 'description', 'action', 'columns', 'search', 'page', 'detail'], where);
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
  const users = validateUsersCapability(tools, tool, columns, raw, where);
  if (typeof users === 'string') return users;
  return { id: raw.id, kind: raw.kind as OperatorResourceKind, title, description, action: tool.name, columns, ...users };
}

/** An optional string param of `tool` (a resource is always called without required input). */
function optionalParam(tool: ToolManifest, param: unknown, where: string): string | null {
  if (typeof param !== 'string' || !tool.params?.[param]) return `${where}: action "${tool.name}" has no param "${String(param)}"`;
  if (tool.params[param]!.type !== 'string') return `${where}: param "${param}" of "${tool.name}" must be type string`;
  return null;
}

/**
 * The users capability (#240 slice 3): search, keyset paging and a per-record
 * detail read, each backed by the app's own role-gated query actions. Only
 * `users` resources declare them today; other kinds keep the plain table.
 */
function validateUsersCapability(
  tools: ToolManifest[],
  tool: ToolManifest,
  columns: OperatorColumn[],
  raw: Obj,
  where: string,
): Pick<OperatorResource, 'search' | 'page' | 'detail'> | string {
  const declared = (['search', 'page', 'detail'] as const).filter((k) => raw[k] !== undefined);
  if (declared.length === 0) return { search: null, page: null, detail: null };
  if (raw.kind !== 'users') return `${where}: ${declared.join(', ')} are only supported on users resources`;

  let search: OperatorResource['search'] = null;
  if (raw.search !== undefined) {
    if (!isObj(raw.search)) return `${where}.search must be an object`;
    const extra = unknownField(raw.search, ['param'], `${where}.search`) ?? optionalParam(tool, raw.search.param, `${where}.search`);
    if (extra) return extra;
    search = { param: raw.search.param as string };
  }

  let page: OperatorResource['page'] = null;
  if (raw.page !== undefined) {
    if (!isObj(raw.page)) return `${where}.page must be an object`;
    const at = `${where}.page`;
    const extra = unknownField(raw.page, ['param', 'column'], at) ?? optionalParam(tool, raw.page.param, at);
    if (extra) return extra;
    if (raw.page.param === search?.param) return `${at}: param must differ from search.param`;
    const cursor = raw.page.column;
    if (!columns.some((c) => c.key === cursor)) return `${at}: column must be a declared column (the cursor is shown to the console)`;
    const size = literalLimit(tool.sql ?? '');
    if (size === null || size < 1 || size > MAX_OPERATOR_PAGE_SIZE) {
      return `${at}: action "${tool.name}" must end with a literal LIMIT of 1-${MAX_OPERATOR_PAGE_SIZE} (the page size)`;
    }
    if (!/\bORDER\s+BY\b/i.test(tool.sql ?? '')) return `${at}: action "${tool.name}" must ORDER BY the cursor column for keyset paging`;
    page = { param: raw.page.param as string, column: cursor as string, size };
  }

  let detail: OperatorResource['detail'] = null;
  if (raw.detail !== undefined) {
    const at = `${where}.detail`;
    if (!isObj(raw.detail)) return `${at} must be an object`;
    const extra = unknownField(raw.detail, ['action', 'param', 'key', 'fields'], at);
    if (extra) return extra;
    const read = gatedTool(tools, raw.detail.action, at);
    if (typeof read === 'string') return read;
    if (read.operation !== 'query') return `${at}: action "${read.name}" must be a query`;
    const param = raw.detail.param;
    if (typeof param !== 'string' || !read.params?.[param]) return `${at}: action "${read.name}" has no param "${String(param)}"`;
    const others = required(read).filter((p) => p !== param);
    if (others.length) return `${at}: action "${read.name}" has required params besides "${param}" (${others.join(', ')})`;
    const key = raw.detail.key;
    if (!columns.some((c) => c.key === key)) return `${at}: key must be a declared column of the resource`;
    const fields = validateColumns(read, raw.detail.fields, at, 'fields', MAX_OPERATOR_DETAIL_FIELDS);
    if (typeof fields === 'string') return fields;
    detail = { action: read.name, param, key: key as string, fields, step_up: read.step_up === true };
  }
  return { search, page, detail };
}

function validateAction(tools: ToolManifest[], resources: OperatorResource[], raw: unknown, where: string): OperatorAction | string {
  if (!isObj(raw)) return `${where} must be an object`;
  const extra = unknownField(raw, ['id', 'title', 'resource', 'action', 'params', 'confirm'], where);
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
  if (tool.operation === 'query') return `${where}: action "${tool.name}" is a query; reads belong in resources`;

  const params = raw.params ?? {};
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
  return { id: raw.id, title, resource: resource.id, action: tool.name, params: mapped, confirm, step_up: tool.step_up === true };
}

/**
 * Validate `operator_view` against the app's (already validated) tools.
 * Absent or null is the baseline: `{ contract: null }`.
 */
export function validateOperatorView(tools: ToolManifest[], raw: unknown): { error: string } | { contract: OperatorViewContract | null } {
  if (raw === undefined || raw === null) return { contract: null };
  if (!isObj(raw)) return { error: 'operator_view must be an object' };
  const extra = unknownField(raw, ['version', 'resources', 'actions'], 'operator_view');
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
  const actions: OperatorAction[] = [];
  for (const [i, a] of rawActions.entries()) {
    const result = validateAction(tools, resources, a, `operator_view.actions[${i}]`);
    if (typeof result === 'string') return { error: result };
    if (ids.has(result.id)) return { error: `operator_view.actions[${i}]: duplicate id "${result.id}"` };
    ids.add(result.id);
    actions.push(result);
  }
  return { contract: { version: 1, resources, actions } };
}
