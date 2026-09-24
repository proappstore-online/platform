/**
 * Console-defined API endpoints (#155): a structured config → a registered-action
 * manifest. The builder never accepts SQL; it emits it. Identifiers come from the
 * app's live schema (read server-side by the route), values are always `:params`,
 * and the result goes through the same validators as an mcp.json tool.
 */
import type { ToolManifest, ToolParam } from './action-sql.js';

/** Console endpoint names live in their own namespace, so they can never shadow a code action or a can_* oracle. */
export const ENDPOINT_NAME_PREFIX = 'api_';
export const ENDPOINT_NAME_RE = /^api_[a-z][a-z0-9_]{0,55}$/;
/** Console endpoints per app — separate from the code-tool cap; each one is also an MCP tool (#117). */
export const CONSOLE_ENDPOINT_CAP = 30;

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FILTER_OPS = { eq: '=', lt: '<', lte: '<=', gt: '>', gte: '>=' } as const;
type FilterOp = keyof typeof FILTER_OPS;

export interface EndpointFilter { column: string; op: FilterOp; optional?: boolean; max?: number }

export interface EndpointConfig {
  name: string;
  description: string;
  kind: 'read' | 'insert';
  table: string;
  scope: 'own' | 'all' | 'public';
  owner_column?: string;
  columns: string[];
  filters?: EndpointFilter[];
  sort?: { column: string; dir: 'asc' | 'desc' };
  page_size?: number;
  paginate?: boolean;
  generated?: Record<string, '__uuid' | '__now'>;
  defaults?: Record<string, string | number | boolean>;
  app_roles?: string[];
}

/** One row of `PRAGMA table_info`, as the data worker returns it. */
export interface ColumnInfo { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }

export type EndpointResult = { ok: true; manifest: ToolManifest } | { ok: false; error: string; details: string[] };

const CONFIG_KEYS = new Set(['name', 'description', 'kind', 'table', 'scope', 'owner_column', 'columns', 'filters', 'sort', 'page_size', 'paginate', 'generated', 'defaults', 'app_roles']);
const FILTER_KEYS = new Set(['column', 'op', 'optional', 'max']);
const SORT_KEYS = new Set(['column', 'dir']);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const unknownKeys = (o: Record<string, unknown>, allowed: Set<string>) => Object.keys(o).filter((k) => !allowed.has(k));

/**
 * Shape check only — no schema needed. Unknown keys are rejected so a typo in the
 * console cannot silently widen an endpoint. Returns the errors, empty when valid.
 */
export function validateEndpointConfig(raw: unknown): string[] {
  if (!isObj(raw)) return ['config must be an object'];
  const e: string[] = [];
  for (const k of unknownKeys(raw, CONFIG_KEYS)) e.push(`unknown key "${k}"`);
  const c = raw as Partial<EndpointConfig> & Record<string, unknown>;
  if (typeof c.name !== 'string' || !ENDPOINT_NAME_RE.test(c.name)) e.push(`name must match ${ENDPOINT_NAME_RE} (the ${ENDPOINT_NAME_PREFIX} prefix is required)`);
  if (typeof c.description !== 'string' || c.description.trim() === '') e.push('description is required');
  if (c.kind !== 'read' && c.kind !== 'insert') e.push('kind must be "read" or "insert"');
  if (typeof c.table !== 'string' || !IDENT_RE.test(c.table)) e.push('table must be an identifier');
  if (c.scope !== 'own' && c.scope !== 'all' && c.scope !== 'public') e.push('scope must be "own", "all" or "public"');
  if (c.scope === 'own' && (typeof c.owner_column !== 'string' || !IDENT_RE.test(c.owner_column))) e.push('owner_column is required for scope "own"');
  if (c.scope !== 'own' && c.owner_column !== undefined) e.push('owner_column only applies to scope "own"');
  if (!isStrArr(c.columns) || c.columns.length === 0 || c.columns.some((x) => !IDENT_RE.test(x))) e.push('columns must be a non-empty array of identifiers');
  else if (new Set(c.columns).size !== c.columns.length) e.push('columns must not repeat');
  if (c.kind === 'insert') {
    if (c.scope !== 'own') e.push('insert endpoints support scope "own" only');
    for (const k of ['filters', 'sort', 'page_size', 'paginate'] as const) if (c[k] !== undefined) e.push(`${k} only applies to read endpoints`);
    if (c.generated !== undefined) {
      if (!isObj(c.generated)) e.push('generated must be an object');
      else for (const [col, v] of Object.entries(c.generated)) {
        if (!IDENT_RE.test(col)) e.push(`generated: "${col}" is not an identifier`);
        if (v !== '__uuid' && v !== '__now') e.push(`generated.${col} must be "__uuid" or "__now"`);
      }
    }
    if (c.defaults !== undefined) {
      if (!isObj(c.defaults)) e.push('defaults must be an object');
      else for (const [col, v] of Object.entries(c.defaults)) {
        if (!IDENT_RE.test(col)) e.push(`defaults: "${col}" is not an identifier`);
        if (!['string', 'number', 'boolean'].includes(typeof v)) e.push(`defaults.${col} must be a string, number or boolean`);
      }
    }
  } else if (c.kind === 'read') {
    for (const k of ['generated', 'defaults'] as const) if (c[k] !== undefined) e.push(`${k} only applies to insert endpoints`);
    if (c.scope === 'public' && c.columns && c.owner_column) e.push('public endpoints have no owner column');
    const maxPage = c.scope === 'public' ? 500 : 100;
    if (typeof c.page_size !== 'number' || !Number.isInteger(c.page_size) || c.page_size < 1 || c.page_size > maxPage) e.push(`page_size must be an integer from 1 to ${maxPage}`);
    if (c.paginate !== undefined && typeof c.paginate !== 'boolean') e.push('paginate must be a boolean');
    if (c.filters !== undefined) {
      if (!Array.isArray(c.filters)) e.push('filters must be an array');
      else c.filters.forEach((f, i) => {
        if (!isObj(f)) { e.push(`filters[${i}] must be an object`); return; }
        for (const k of unknownKeys(f, FILTER_KEYS)) e.push(`filters[${i}]: unknown key "${k}"`);
        if (typeof f.column !== 'string' || !IDENT_RE.test(f.column)) e.push(`filters[${i}].column must be an identifier`);
        if (typeof f.op !== 'string' || !(f.op in FILTER_OPS)) e.push(`filters[${i}].op must be one of ${Object.keys(FILTER_OPS).join(', ')}`);
        if (f.optional !== undefined && typeof f.optional !== 'boolean') e.push(`filters[${i}].optional must be a boolean`);
        if (f.max !== undefined && (typeof f.max !== 'number' || !Number.isFinite(f.max))) e.push(`filters[${i}].max must be a number`);
      });
    }
    if (c.sort !== undefined) {
      if (!isObj(c.sort)) e.push('sort must be an object');
      else {
        for (const k of unknownKeys(c.sort, SORT_KEYS)) e.push(`sort: unknown key "${k}"`);
        if (typeof c.sort.column !== 'string' || !IDENT_RE.test(c.sort.column)) e.push('sort.column must be an identifier');
        if (c.sort.dir !== 'asc' && c.sort.dir !== 'desc') e.push('sort.dir must be "asc" or "desc"');
      }
    }
  }
  if (c.scope === 'all') {
    if (!isStrArr(c.app_roles) || c.app_roles.length === 0 || c.app_roles.some((r) => r.trim() === '')) e.push('app_roles is required and must be non-empty for scope "all"');
  } else if (c.app_roles !== undefined) e.push('app_roles only applies to scope "all"');
  if (c.scope === 'public' && c.kind === 'insert') e.push('public endpoints are read-only');
  return e;
}

/** SQLite column affinity → the param types resolveParams understands. */
export function paramTypeFor(declared: string): string {
  const t = (declared || '').toUpperCase();
  if (t.includes('INT')) return 'integer';
  if (/REAL|FLOA|DOUB|NUMERIC|DECIMAL/.test(t)) return 'number';
  if (t.includes('BOOL')) return 'boolean';
  return 'string';
}

const q = (ident: string) => `"${ident}"`;

/**
 * Build the manifest. `columns` is the live `PRAGMA table_info` of `config.table`;
 * an empty list means the table does not exist. Every identifier the config names
 * must be in it — the generator never trusts the console's idea of the schema.
 */
export function generateEndpointManifest(config: EndpointConfig, columns: ColumnInfo[]): EndpointResult {
  const shape = validateEndpointConfig(config);
  if (shape.length) return { ok: false, error: 'invalid endpoint config', details: shape };
  if (columns.length === 0) return { ok: false, error: `table "${config.table}" does not exist`, details: [`table "${config.table}" not found in the app schema`] };
  const byName = new Map(columns.map((c) => [c.name, c]));
  const details: string[] = [];
  const known = (col: string, where: string) => {
    if (!byName.has(col)) details.push(`${where}: column "${col}" does not exist on "${config.table}"`);
  };
  for (const col of config.columns) known(col, 'columns');
  if (config.owner_column) known(config.owner_column, 'owner_column');

  const params: Record<string, ToolParam> = {};
  let sql: string;

  if (config.kind === 'read') {
    for (const f of config.filters ?? []) known(f.column, 'filters');
    if (config.sort) known(config.sort.column, 'sort');
    if (details.length) return { ok: false, error: 'invalid endpoint config', details };
    const where: string[] = [];
    if (config.scope === 'own') where.push(`${q(config.owner_column!)} = :__user_id`);
    for (const f of config.filters ?? []) {
      const p = f.op === 'eq' ? f.column : `${f.column}_${f.op}`;
      if (p in params || p === 'offset') return { ok: false, error: 'invalid endpoint config', details: [`filters: parameter "${p}" is declared twice`] };
      const col = byName.get(f.column)!;
      params[p] = { type: paramTypeFor(col.type), description: `${f.op} filter on ${f.column}`, ...(f.optional ? { optional: true } : {}), ...(f.max !== undefined ? { max: f.max } : {}) };
      const cmp = `${q(f.column)} ${FILTER_OPS[f.op]} :${p}`;
      where.push(f.optional ? `(:${p} IS NULL OR ${cmp})` : cmp);
    }
    sql = `SELECT ${config.columns.map(q).join(',')} FROM ${q(config.table)}`;
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
    if (config.sort) sql += ` ORDER BY ${q(config.sort.column)} ${config.sort.dir.toUpperCase()}`;
    sql += ` LIMIT ${config.page_size}`;
    if (config.paginate) {
      params.offset = { type: 'integer', description: 'rows to skip', optional: true, default: 0 };
      sql += ' OFFSET :offset';
    }
  } else {
    const generated = config.generated ?? {};
    const defaults = config.defaults ?? {};
    for (const col of Object.keys(generated)) known(col, 'generated');
    for (const col of Object.keys(defaults)) {
      known(col, 'defaults');
      if (!config.columns.includes(col)) details.push(`defaults: "${col}" is not one of the writable columns`);
    }
    if (config.columns.includes(config.owner_column!)) details.push(`columns: the owner column "${config.owner_column}" is filled by the server and cannot be writable`);
    for (const col of Object.keys(generated)) {
      if (config.columns.includes(col)) details.push(`generated: "${col}" cannot also be a writable column`);
      if (col === config.owner_column) details.push(`generated: the owner column "${col}" is filled from the caller`);
    }
    // Every column the row needs must come from somewhere: the caller, the server, the schema default, or the owner.
    for (const col of columns) {
      const covered = config.columns.includes(col.name) || col.name in generated || col.name === config.owner_column;
      if (!covered && col.notnull && col.dflt_value === null && !(col.pk && /INT/i.test(col.type))) {
        details.push(`column "${col.name}" is NOT NULL with no default: add it to columns or generated`);
      }
    }
    if (details.length) return { ok: false, error: 'invalid endpoint config', details };
    const names = [config.owner_column!, ...Object.keys(generated), ...config.columns];
    const values = [':__user_id', ...Object.values(generated).map((g) => `:${g}`), ...config.columns.map((c) => `:${c}`)];
    for (const col of config.columns) {
      const info = byName.get(col)!;
      const p: ToolParam = { type: paramTypeFor(info.type), description: `value for ${col}` };
      if (col in defaults) p.default = defaults[col];
      else if (!info.notnull) p.optional = true;
      params[col] = p;
    }
    sql = `INSERT INTO ${q(config.table)} (${names.map(q).join(', ')}) VALUES (${values.join(', ')})`;
  }

  const manifest: ToolManifest = {
    name: config.name,
    description: config.description,
    operation: config.kind === 'read' ? 'query' : 'execute',
    sql,
    params,
    requires_auth: config.scope !== 'public',
  };
  if (config.scope === 'all') {
    manifest.auth = {
      app_roles: config.app_roles!,
      caller_unscoped: { reason: `console endpoint: all-rows scope, gated by app role(s) ${config.app_roles!.join(', ')}` },
    };
  }
  return { ok: true, manifest };
}
