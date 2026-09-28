/**
 * Types and validation helpers shared by the operator-view contract modules
 * (#240): operator-contract.ts (resources, actions, the whole contract) and
 * operator-contract-lists.ts (search, paging, detail, status, related).
 */
import { selectsColumn, type ToolManifest } from './action-sql.js';
import type { OperatorSeries } from './operator-contract-series.js';

export const OPERATOR_RESOURCE_KINDS = ['users', 'reports', 'suspensions', 'verification', 'metrics'] as const;
const OPERATOR_COLUMN_FORMATS = ['text', 'number', 'datetime', 'boolean', 'badge'] as const;
const MAX_OPERATOR_COLUMNS = 12;

export type OperatorResourceKind = (typeof OPERATOR_RESOURCE_KINDS)[number];
type OperatorColumnFormat = (typeof OPERATOR_COLUMN_FORMATS)[number];

export interface OperatorColumn { key: string; label: string; format: OperatorColumnFormat }

/**
 * Per-record read: `action` runs with `param` = the row's `key` column.
 * `evidence` (verification only) names detail fields holding a `_review/`
 * document path, served by the platform — never the path itself.
 */
interface OperatorDetail {
  action: string;
  param: string;
  key: string;
  fields: OperatorColumn[];
  step_up: boolean;
  evidence?: { field: string; label: string }[] | null;
}

/** A status workflow: the column holding a row's state, the states, and the optional filter param. */
export interface OperatorStatus { column: string; states: { value: string; label: string }[]; param: string | null }

export interface OperatorResource {
  id: string;
  kind: OperatorResourceKind;
  title: string;
  description: string | null;
  action: string;
  columns: OperatorColumn[];
  // The list capabilities (operator-contract-lists.ts) — users, reports and suspensions only.
  // Optional: contracts stored before a capability existed lack the key.
  search?: { param: string } | null;
  /** Keyset paging. `param` receives the last row's `column`; `size` is the query's literal LIMIT. */
  page?: { param: string; column: string; size: number } | null;
  detail?: OperatorDetail | null;
  status?: OperatorStatus | null;
  /** Listed per record of another resource: `param` receives that record's detail key (e.g. a user's suspension history). */
  related?: { resource: string; param: string } | null;
  /** Metrics only: a time series read through the metrics route (operator-contract-series.ts). */
  series?: OperatorSeries | null;
}

export interface OperatorAction {
  id: string;
  title: string;
  resource: string;
  action: string;
  params: Record<string, string>;
  confirm: string;
  /** Copied from the action's manifest, so the console can say a re-auth is needed before it asks. */
  step_up: boolean;
  /** Offered only on rows whose status is in `from`; the app's SQL guards it with the mapped status param. */
  transition?: { from: string[]; to: string } | null;
  /** Irreversible or account-affecting: its action must declare step_up. */
  destructive?: boolean;
  /** The resource column whose value the audit records as the action's target. */
  target?: string | null;
}

export interface OperatorViewContract {
  version: 1;
  resources: OperatorResource[];
  actions: OperatorAction[];
}

export const ID = /^[a-z][a-z0-9_]{0,49}$/;
const COLUMN_KEY = /^[a-z_][a-z0-9_]{0,49}$/;

export type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export function unknownField(value: Obj, allowed: readonly string[], where: string): string | null {
  const extra = Object.keys(value).find((k) => !allowed.includes(k));
  return extra === undefined ? null : `${where}: unknown field "${extra}"`;
}

export function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : null;
}

/** The referenced tool, or why it may not back an operator resource/action. */
export function gatedTool(tools: ToolManifest[], name: unknown, where: string): ToolManifest | string {
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

export const required = (tool: ToolManifest) =>
  Object.entries(tool.params ?? {}).filter(([, p]) => !p.optional && p.default === undefined).map(([k]) => k);

/** An optional string param of `tool` (a resource is always called without required input). */
export function optionalParam(tool: ToolManifest, param: unknown, where: string): string | null {
  if (typeof param !== 'string' || !tool.params?.[param]) return `${where}: action "${tool.name}" has no param "${String(param)}"`;
  if (tool.params[param]!.type !== 'string') return `${where}: param "${param}" of "${tool.name}" must be type string`;
  return null;
}

export function validateColumns(tool: ToolManifest, value: unknown, where: string, name = 'columns', max = MAX_OPERATOR_COLUMNS): OperatorColumn[] | string {
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
