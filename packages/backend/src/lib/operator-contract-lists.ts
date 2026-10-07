/**
 * The list capabilities of an operator resource (#240): search, keyset paging,
 * a per-record detail read, a status workflow and "related" listing (a
 * resource listed per record of another, e.g. a user's suspension history).
 * Each is optional and backed by the app's own role-gated query actions.
 * Declared on users, reports, suspensions and verification (whose detail may
 * also name `evidence` documents); metrics keep the plain KPI row.
 */
import { literalLimit, type ToolManifest } from './action-sql.js';
import {
  gatedTool, isObj, optionalParam, required, text, unknownField, validateColumns,
  type Obj, type OperatorColumn, type OperatorResource, type OperatorStatus,
} from './operator-contract-shared.js';

export const LIST_KINDS = ['users', 'reports', 'suspensions', 'verification'];
export const MAX_EVIDENCE = 6;
export const LIST_CAPABILITIES = ['search', 'page', 'detail', 'status', 'related'] as const;
export const MAX_DETAIL_FIELDS = 24;
export const MAX_PAGE_SIZE = 200; // a paged resource's page size is its query's literal LIMIT
export const MAX_STATES = 12;

type Capabilities = Pick<OperatorResource, (typeof LIST_CAPABILITIES)[number]>;

export function validateListCapabilities(
  tools: ToolManifest[],
  tool: ToolManifest,
  columns: OperatorColumn[],
  raw: Obj,
  where: string,
): Capabilities | string {
  const none: Capabilities = { search: null, page: null, detail: null, status: null, related: null };
  const declared = LIST_CAPABILITIES.filter((k) => raw[k] !== undefined);
  if (declared.length === 0) return none;
  if (!LIST_KINDS.includes(raw.kind as string)) return `${where}: ${declared.join(', ')} are only supported on ${LIST_KINDS.join(', ')} resources`;

  const out = { ...none };
  const params = new Set<string>();
  /** A list param, distinct from the resource's other list params. */
  const listParam = (value: Obj, at: string): string | null => {
    const bad = optionalParam(tool, value.param, at);
    if (bad) return bad;
    if (params.has(value.param as string)) return `${at}: param "${String(value.param)}" is already used by another capability`;
    params.add(value.param as string);
    return null;
  };
  const shape = (name: string, allowed: string[]): { value: Obj; at: string } | string => {
    const value = raw[name];
    const at = `${where}.${name}`;
    if (!isObj(value)) return `${at} must be an object`;
    return unknownField(value, allowed, at) ?? { value, at };
  };

  if (raw.search !== undefined) {
    const s = shape('search', ['param']);
    if (typeof s === 'string') return s;
    const bad = listParam(s.value, s.at);
    if (bad) return bad;
    out.search = { param: s.value.param as string };
  }

  if (raw.page !== undefined) {
    const s = shape('page', ['param', 'column']);
    if (typeof s === 'string') return s;
    const bad = listParam(s.value, s.at);
    if (bad) return bad;
    const cursor = s.value.column;
    if (!columns.some((c) => c.key === cursor)) return `${s.at}: column must be a declared column (the cursor is shown to the console)`;
    const size = literalLimit(tool.sql ?? '');
    if (size === null || size < 1 || size > MAX_PAGE_SIZE) {
      return `${s.at}: action "${tool.name}" must end with a literal LIMIT of 1-${MAX_PAGE_SIZE} (the page size)`;
    }
    if (!/\bORDER\s+BY\b/i.test(tool.sql ?? '')) return `${s.at}: action "${tool.name}" must ORDER BY the cursor column for keyset paging`;
    out.page = { param: s.value.param as string, column: cursor as string, size };
  }

  if (raw.status !== undefined) {
    const s = shape('status', ['column', 'states', 'param']);
    if (typeof s === 'string') return s;
    const status = validateStatus(columns, s.value, s.at, listParam);
    if (typeof status === 'string') return status;
    out.status = status;
  }

  if (raw.related !== undefined) {
    const s = shape('related', ['resource', 'param']);
    if (typeof s === 'string') return s;
    const bad = listParam(s.value, s.at);
    if (bad) return bad;
    // The resource it names is resolved once every resource is known (resolveRelated).
    if (typeof s.value.resource !== 'string') return `${s.at}: resource must be the id of a declared resource`;
    out.related = { resource: s.value.resource, param: s.value.param as string };
  }

  if (raw.detail !== undefined) {
    const s = shape('detail', ['action', 'param', 'key', 'fields', 'evidence']);
    if (typeof s === 'string') return s;
    const detail = validateDetail(tools, columns, s.value, s.at, raw.kind === 'verification');
    if (typeof detail === 'string') return detail;
    out.detail = detail;
  }
  return out;
}

function validateStatus(
  columns: OperatorColumn[],
  value: Obj,
  at: string,
  listParam: (value: Obj, at: string) => string | null,
): OperatorStatus | string {
  if (!columns.some((c) => c.key === value.column)) return `${at}: column must be a declared column`;
  if (!Array.isArray(value.states) || value.states.length === 0 || value.states.length > MAX_STATES) {
    return `${at}: states must be an array of 1-${MAX_STATES}`;
  }
  const states: OperatorStatus['states'] = [];
  for (const [i, state] of value.states.entries()) {
    const s = `${at}.states[${i}]`;
    if (!isObj(state)) return `${s} must be an object`;
    const extra = unknownField(state, ['value', 'label'], s);
    if (extra) return extra;
    const v = text(state.value, 50);
    const label = text(state.label, 40);
    if (!v || !label) return `${s}: value (max 50 chars) and label (max 40 chars) are required`;
    if (states.some((x) => x.value === v)) return `${s}: duplicate state "${v}"`;
    states.push({ value: v, label });
  }
  let param: string | null = null;
  if (value.param !== undefined) {
    const bad = listParam(value, at);
    if (bad) return bad;
    param = value.param as string;
  }
  return { column: value.column as string, states, param };
}

function validateDetail(
  tools: ToolManifest[],
  columns: OperatorColumn[],
  value: Obj,
  at: string,
  verification: boolean,
): NonNullable<OperatorResource['detail']> | string {
  const read = gatedTool(tools, value.action, at);
  if (typeof read === 'string') return read;
  if (read.operation !== 'query') return `${at}: action "${read.name}" must be a query`;
  const param = value.param;
  if (typeof param !== 'string' || !read.params?.[param]) return `${at}: action "${read.name}" has no param "${String(param)}"`;
  const others = required(read).filter((p) => p !== param);
  if (others.length) return `${at}: action "${read.name}" has required params besides "${param}" (${others.join(', ')})`;
  const key = value.key;
  if (!columns.some((c) => c.key === key)) return `${at}: key must be a declared column of the resource`;
  const fields = validateColumns(read, value.fields, at, 'fields', MAX_DETAIL_FIELDS);
  if (typeof fields === 'string') return fields;
  let evidence: { field: string; label: string }[] | null = null;
  if (value.evidence !== undefined) {
    if (!verification) return `${at}.evidence: only verification resources declare evidence`;
    const e = validateEvidence(fields, value.evidence, `${at}.evidence`);
    if (typeof e === 'string') return e;
    evidence = e;
  }
  return { action: read.name, param, key: key as string, fields, step_up: read.step_up === true, evidence };
}

/** Detail fields that hold a `_review/u/<uid>/<path>` document path, each with the label the console shows. */
function validateEvidence(fields: OperatorColumn[], value: unknown, at: string): { field: string; label: string }[] | string {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_EVIDENCE) return `${at} must be an array of 1-${MAX_EVIDENCE}`;
  const out: { field: string; label: string }[] = [];
  for (const [i, item] of value.entries()) {
    const e = `${at}[${i}]`;
    if (!isObj(item)) return `${e} must be an object`;
    const extra = unknownField(item, ['field', 'label'], e);
    if (extra) return extra;
    if (!fields.some((f) => f.key === item.field)) return `${e}: field must be a declared detail field`;
    if (out.some((x) => x.field === item.field)) return `${e}: duplicate field "${String(item.field)}"`;
    const label = text(item.label, 40);
    if (!label) return `${e}: label is required (max 40 chars)`;
    out.push({ field: item.field as string, label });
  }
  return out;
}

/** Once every resource is known: a `related` resource must name another resource that has a detail page. */
export function resolveRelated(resources: OperatorResource[]): string | null {
  for (const [i, r] of resources.entries()) {
    const related = r.related;
    if (!related) continue;
    const parent = resources.find((p) => p.id === related.resource);
    if (!parent || parent.id === r.id || !parent.detail) {
      return `operator_view.resources[${i}].related: resource must be another declared resource with a detail`;
    }
  }
  return null;
}
