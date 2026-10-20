/**
 * Deny-by-default for unscoped actions (platform#426), shared by the platform's
 * registration gate (backend `routes/tools.ts`) and the `mcp-unscoped` compliance
 * check, so `pas check`, an app's CI and the deploy apply one rule.
 *
 * An action's statements must be scoped to the caller with `:__user_id` unless it
 * declares `auth.caller_unscoped`. That exemption is the risk this module bounds:
 * an unscoped statement that ANY signed-in user can run reads or writes every
 * tenant's rows (doordrop#85: `get_user` returned every user's email and phone).
 *
 * - An action is **open-unscoped** when a signed-in user can run it and nothing
 *   narrows who: it requires auth, is not scheduled, lists "user" in its callers
 *   (the default), carries no app or platform role gate, and declares
 *   `caller_unscoped`. Worker-only, hook-only, scheduled, role-gated and public
 *   actions are not: a user cannot reach them, or a role already decides who can.
 * - An open-unscoped action needs an explicit, reviewed entry in the manifest's
 *   top-level `approved_unscoped` list: `{ action, reviewer, date, reason }`.
 *   A `caller_unscoped.reason` alone no longer opens an action to every user.
 * - An open-unscoped action may never return personal data: no output column
 *   named like an email, phone, address or location, and no `*` / `t.*`, which
 *   could return one. Approval does not lift this.
 */

export interface UnscopedPolicyTool {
  name: string;
  operation?: string;
  sql?: string;
  statements?: string[];
  requires_auth?: boolean;
  schedule?: unknown;
  callers?: string[];
  auth?: { caller_unscoped?: { reason?: unknown }; app_roles?: string[]; platform_roles?: string[] };
}

export interface UnscopedApproval {
  action: string;
  reviewer: string;
  /** ISO date of the review, YYYY-MM-DD. */
  date: string;
  reason: string;
}

export const MAX_UNSCOPED_APPROVALS = 200;

/**
 * Parts of a column name that mark personal data. A name matches when one of its
 * underscore-separated parts is listed (`contact_email`, `phone_number`,
 * `home_address`, `date_of_birth`); a key or count of one (`location_id`,
 * `email_count`) does not.
 */
export const PERSONAL_DATA_COLUMN_PARTS: readonly string[] = [
  'email', 'phone', 'mobile', 'address', 'street', 'postcode', 'location',
  'lat', 'lng', 'latitude', 'longitude', 'dob', 'birth', 'birthdate', 'birthday',
];
const NOT_PERSONAL_SUFFIXES = ['_id', '_ids', '_count', '_verified', '_at'];

/** The statements an action runs, as the platform executes them. */
export function policyStatements(tool: UnscopedPolicyTool): string[] {
  if (tool.operation === 'batch') return tool.statements ?? [];
  if (tool.operation === 'verify') return [tool.sql ?? '', ...(tool.statements ?? [])];
  return [tool.sql ?? ''];
}

/** Does the action declare an unscoped exemption (with a reason, as registration requires)? */
export function declaresUnscoped(tool: UnscopedPolicyTool): boolean {
  return tool.auth?.caller_unscoped !== undefined;
}

/** Open-unscoped: any signed-in user can run its unscoped statements. */
export function isOpenUnscoped(tool: UnscopedPolicyTool): boolean {
  return declaresUnscoped(tool)
    && tool.requires_auth !== false
    && tool.schedule === undefined
    && (tool.callers ?? ['user']).includes('user')
    && !tool.auth?.app_roles?.length
    && !tool.auth?.platform_roles?.length;
}

/** SQL with comments removed and string-literal contents blanked, lower-cased. */
function normalise(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/:[a-z_][a-z0-9_]*/gi, ' ')
    .toLowerCase();
}

/** Text at paren depth 0 relative to `text`'s start (nested parentheses blanked). */
function topLevel(text: string): string {
  let depth = 0;
  let out = '';
  for (const ch of text) {
    if (ch === '(') { depth += 1; out += ' '; continue; }
    if (ch === ')') { depth = Math.max(0, depth - 1); out += ' '; continue; }
    out += depth === 0 ? ch : ' ';
  }
  return out;
}

/** `text` with every parenthesised sub-select removed; each is its own output list. */
function withoutSubqueries(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '(' && /^\(\s*select\b/.test(text.slice(i))) {
      let depth = 0;
      for (; i < text.length; i++) {
        if (text[i] === '(') depth += 1;
        else if (text[i] === ')' && --depth === 0) { i += 1; break; }
      }
      out += ' ';
      continue;
    }
    out += text[i];
    i += 1;
  }
  return out;
}

const LIST_END = /^(from|union|intersect|except|where|group|order|limit|window|having)\b/;

/**
 * The output lists of a statement: each SELECT's list (up to its own FROM, at its
 * own depth) and a RETURNING list. Sub-selects are lists too, since what they
 * return can surface in the outer result.
 */
function outputLists(sql: string): string[] {
  const s = normalise(sql);
  const lists: string[] = [];
  const select = /\bselect\b/g;
  let m: RegExpExecArray | null;
  while ((m = select.exec(s)) !== null) {
    let depth = 0;
    let end = s.length;
    for (let i = m.index + 6; i < s.length; i++) {
      const ch = s[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') { if (depth === 0) { end = i; break; } depth -= 1; }
      else if (ch === ';' && depth === 0) { end = i; break; }
      else if (depth === 0 && /\W/.test(s[i - 1] ?? ' ') && LIST_END.test(s.slice(i))) { end = i; break; }
    }
    lists.push(withoutSubqueries(s.slice(m.index + 6, end)));
  }
  const returning = /\breturning\b([\s\S]*?)(;|$)/g;
  while ((m = returning.exec(s)) !== null) lists.push(m[1] ?? '');
  return lists;
}

function personalColumn(identifier: string): boolean {
  if (NOT_PERSONAL_SUFFIXES.some((suffix) => identifier.endsWith(suffix))) return false;
  return identifier.split('_').some((part) => PERSONAL_DATA_COLUMN_PARTS.includes(part));
}

export interface PersonalDataExposure {
  /** `*` or `t.*` in an output list: the columns cannot be checked, so it counts as exposing. */
  star: boolean;
  /** Personal-data column names found in output lists (names or aliases). */
  columns: string[];
}

/** What a statement could return that names a person. */
export function personalDataExposure(sql: string): PersonalDataExposure {
  let star = false;
  const columns = new Set<string>();
  for (const list of outputLists(sql)) {
    const top = topLevel(list);
    // A whole item `*` or `t.*` (after an optional DISTINCT/ALL); `a * 2` is arithmetic.
    if (top.split(',').some((item) => /^\s*(?:(?:distinct|all)\s+)?(?:[a-z_][a-z0-9_]*\s*\.\s*)?\*\s*$/.test(item))) star = true;
    for (const id of list.match(/[a-z_][a-z0-9_]*/g) ?? []) if (personalColumn(id)) columns.add(id);
  }
  return { star, columns: [...columns].sort() };
}

/** The exposure across all of an action's statements, or null when none. */
export function actionPersonalData(tool: UnscopedPolicyTool): PersonalDataExposure | null {
  let star = false;
  const columns = new Set<string>();
  for (const sql of policyStatements(tool)) {
    const e = personalDataExposure(sql);
    star ||= e.star;
    for (const c of e.columns) columns.add(c);
  }
  return star || columns.size ? { star, columns: [...columns].sort() } : null;
}

export function describeExposure(e: PersonalDataExposure): string {
  const parts = [e.columns.length ? `personal-data column(s) ${e.columns.join(', ')}` : '', e.star ? '`*` (any column, so possibly personal data)' : ''].filter(Boolean);
  return parts.join(' and ');
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Validate a manifest's `approved_unscoped` list. Absent is an empty list. */
export function validateApprovals(raw: unknown): { error: string } | { approvals: Map<string, UnscopedApproval> } {
  const approvals = new Map<string, UnscopedApproval>();
  if (raw === undefined || raw === null) return { approvals };
  if (!Array.isArray(raw)) return { error: 'approved_unscoped must be an array of { action, reviewer, date, reason }' };
  if (raw.length > MAX_UNSCOPED_APPROVALS) return { error: `approved_unscoped: at most ${MAX_UNSCOPED_APPROVALS} entries` };
  for (const [i, entry] of raw.entries()) {
    const at = `approved_unscoped[${i}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { error: `${at} must be an object` };
    const e = entry as Record<string, unknown>;
    for (const field of ['action', 'reviewer', 'date', 'reason'] as const) {
      if (typeof e[field] !== 'string' || !(e[field] as string).trim()) return { error: `${at}.${field} must be a non-empty string` };
    }
    if (!isIsoDate((e.date as string).trim())) return { error: `${at}.date must be an ISO date, YYYY-MM-DD` };
    const action = (e.action as string).trim();
    if (approvals.has(action)) return { error: `${at}: action "${action}" is approved twice` };
    approvals.set(action, { action, reviewer: (e.reviewer as string).trim(), date: (e.date as string).trim(), reason: (e.reason as string).trim() });
  }
  return { approvals };
}

export interface UnscopedEvaluation {
  /** Refusals: the registration (or check) must not pass. */
  errors: string[];
  warnings: string[];
  /** Open-unscoped actions accepted only because they were already registered unchanged. */
  grandfathered: string[];
}

/** Same statements as before: an unchanged action keeps its registration. */
function sameStatements(a: UnscopedPolicyTool, b: UnscopedPolicyTool): boolean {
  return JSON.stringify(policyStatements(a).map((x) => x.trim())) === JSON.stringify(policyStatements(b).map((x) => x.trim()));
}

/**
 * Apply the policy to an app's action set.
 *
 * `previous` is the set currently registered, by name. An open-unscoped action
 * that was already registered open-unscoped with the same statements is
 * grandfathered: accepted with a warning while it lacks approval, and with a
 * [SECURITY] warning (not a refusal) if it returns personal data. Anything new or
 * changed must be approved and must not return personal data.
 *
 * `previous: null` means the registry is unknown (an app's CI): every gap is
 * reported as a warning, except what approval cannot fix — an approved action
 * that returns personal data — which is an error.
 */
export function evaluateUnscoped(opts: {
  tools: UnscopedPolicyTool[];
  approvals: Map<string, UnscopedApproval>;
  previous: Map<string, UnscopedPolicyTool> | null;
}): UnscopedEvaluation {
  const { tools, approvals, previous } = opts;
  const errors: string[] = [];
  const warnings: string[] = [];
  const grandfathered: string[] = [];
  const unapprovedKept: string[] = [];
  const open = new Set<string>();
  for (const tool of tools) {
    if (!isOpenUnscoped(tool)) continue;
    open.add(tool.name);
    const approved = approvals.has(tool.name);
    const pii = actionPersonalData(tool);
    const before = previous?.get(tool.name);
    const kept = previous !== null && before !== undefined && isOpenUnscoped(before) && sameStatements(before, tool);
    const where = `tool "${tool.name}"`;
    if (kept) {
      grandfathered.push(tool.name);
      if (pii) warnings.push(`[SECURITY] ${where} is caller_unscoped and returns ${describeExposure(pii)} to any signed-in user. Scope it to :__user_id, gate it with auth.app_roles, or drop those columns; a changed version will be refused (PAS-DATA-012)`);
      if (!approved) unapprovedKept.push(tool.name);
      continue;
    }
    if (pii) {
      const msg = `${where} is caller_unscoped and returns ${describeExposure(pii)}: any signed-in user would read every user's. An unscoped action may not return personal data, approved or not. Scope it to :__user_id, gate it with auth.app_roles, or select only non-personal columns (PAS-DATA-012)`;
      if (previous === null && !approved) warnings.push(`[SECURITY] ${msg}`);
      else errors.push(msg);
      continue;
    }
    if (!approved) {
      const msg = `${where} is caller_unscoped and open to every signed-in user, and has no approved_unscoped entry. Scope it to :__user_id, restrict it with auth.app_roles or callers, or add { "action": "${tool.name}", "reviewer", "date", "reason" } to approved_unscoped after review (PAS-DATA-012)`;
      if (previous === null) warnings.push(msg);
      else errors.push(msg);
    }
  }
  for (const name of approvals.keys()) {
    if (!open.has(name)) warnings.push(`approved_unscoped: "${name}" is not an open caller_unscoped action; remove the stale approval`);
  }
  if (unapprovedKept.length) {
    warnings.push(`${unapprovedKept.length} action(s) are caller_unscoped and require approval before next registration change: ${unapprovedKept.join(', ')}`);
  }
  return { errors, warnings, grandfathered };
}
