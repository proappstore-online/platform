/**
 * App tool CRUD — apps register MCP tools via `pas publish` (reads mcp.json).
 *
 * The MCP server reads them back through GET /v1/apps/:appId/tools for one
 * app (an app-scoped session registers that app's tools; the shared session
 * reaches them through list_app_tools / call_app_tool, #157). Callers outside
 * the app's team get only the allowlisted public view — never SQL (#158).
 * There is no cross-app listing: GET /v1/tools was retired (#193).
 */

import { Hono } from 'hono';
import { internalTokenOk } from '@proappstore/build-core';
import type { Env } from '../types.js';
import { requireAppAccess, requireAppOwner } from '../lib/auth.js';
import { dataWorkerUrl } from '../lib/data-worker-url.js';
import { VERIFY_PARAM_PREFIX, resolveToolParams, type ToolManifest, type ToolParam } from '../lib/action-sql.js';
import { ENDPOINT_NAME_PREFIX } from '../lib/endpoint-sql.js';
import { getVerifier, VERIFIERS } from '../lib/verifiers/index.js';

export const toolsRoutes = new Hono<{ Bindings: Env }>();

// ── Allowed SQL prefixes and safety rules ──────────────────────────
const ALLOWED_PREFIXES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
const FORBIDDEN_KEYWORDS = ['CREATE', 'DROP', 'ALTER', 'PRAGMA', 'ATTACH', 'DETACH', 'VACUUM', 'REINDEX'];

/** Strip line and block comments, so a comment cannot hide a paren or a keyword from the scan. */
function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--.*$/gm, ' ');
}

/**
 * The verb of the statement a leading CTE prefixes (#120).
 *
 * `WITH [RECURSIVE] name [(cols)] AS [NOT MATERIALIZED] ( … ) [, …] <verb> …`
 * is one statement in SQLite, and a recursive CTE in front of an INSERT or
 * UPDATE is the natural way to do server-side validation in a SQL-only action
 * surface. Skip the CTE list by tracking parenthesis depth — ignoring parens
 * inside single-quoted strings — and return the first token after it. Without
 * a WITH prefix the verb is simply the first token. Returns null when no verb
 * can be found (unterminated CTE, empty statement).
 */
export function mainStatementVerb(sql: string): string | null {
  const text = stripComments(sql).trim();
  const upper = text.toUpperCase();
  if (!/^WITH\b/.test(upper)) return /^[A-Z]+/.exec(upper)?.[0] ?? null;

  let i = /^WITH\s+RECURSIVE\b/.test(upper) ? 'WITH RECURSIVE'.length : 'WITH'.length;
  for (;;) {
    // Advance to this CTE's body: the first "(" that follows its AS keyword.
    const as = /\bAS\s*(?:NOT\s+)?(?:MATERIALIZED\s*)?\(/g;
    as.lastIndex = i;
    const m = as.exec(upper);
    if (!m) return null;
    let depth = 0;
    let j = m.index + m[0].length - 1; // at the "("
    for (; j < text.length; j++) {
      const ch = text[j];
      if (ch === "'") {
        // Skip a string literal ('' is an escaped quote).
        j++;
        while (j < text.length && !(text[j] === "'" && text[j + 1] !== "'")) j += text[j] === "'" ? 2 : 1;
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')' && --depth === 0) break;
    }
    if (depth !== 0) return null;
    i = j + 1;
    const rest = upper.slice(i).trimStart();
    if (rest.startsWith(',')) { i += upper.slice(i).indexOf(',') + 1; continue; }
    return /^[A-Z]+/.exec(rest)?.[0] ?? null;
  }
}

function validateSql(sql: string, operation: string): string | null {
  const trimmed = sql.trim();
  const upper = trimmed.toUpperCase();

  // The statement — after any leading WITH clause (#120) — must be one of the
  // allowed verbs. `WITH` itself is not a verb: a CTE only prefixes one.
  const verb = mainStatementVerb(trimmed);
  if (!verb || !ALLOWED_PREFIXES.includes(verb)) {
    return `SQL must start with ${ALLOWED_PREFIXES.join(', ')} (optionally preceded by a WITH / WITH RECURSIVE clause)`;
  }
  const isSelectLike = verb === 'SELECT';

  // No semicolons (prevent multi-statement)
  if (trimmed.includes(';')) {
    return 'SQL must not contain semicolons (no multi-statement)';
  }

  // No DDL keywords
  for (const kw of FORBIDDEN_KEYWORDS) {
    // Match as whole word
    if (new RegExp(`\\b${kw}\\b`, 'i').test(trimmed)) {
      return `SQL must not contain ${kw}`;
    }
  }

  // UPDATE/DELETE must have WHERE (verb of the main statement, so a CTE-prefixed
  // UPDATE is held to the same rule).
  if ((verb === 'UPDATE' || verb === 'DELETE') && !upper.includes('WHERE')) {
    return `${operation === 'execute' ? 'UPDATE/DELETE' : 'Mutation'} SQL must have a WHERE clause`;
  }

  // operation match
  if (operation === 'query' && !isSelectLike) {
    return 'operation "query" must use SELECT';
  }
  if (operation === 'execute' && isSelectLike) {
    return 'operation "execute" must not use SELECT (use "query" instead)';
  }

  return null; // valid
}

function literalLimit(sql: string): number | null {
  const withoutComments = sql
    .replace(/--.*$/gm, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
  const match = /\bLIMIT\s+(\d+)\b/i.exec(withoutComments);
  if (!match) return null;
  const tail = withoutComments.slice(match.index + match[0].length).trim();
  if (tail.startsWith(',')) return null;
  return Number(match[1]);
}

export type { ToolManifest, ToolParam };

/** Above this many model-facing bytes the registration answers with a soft warning (#117). */
export const MANIFEST_BYTES_SOFT_LIMIT = 50_000;

/**
 * Hard cap on tools per app. An abuse bound, not a design target: 120 rejected
 * real CRM/ERP-shaped manifests (#116). Payload cost is policed separately by
 * MANIFEST_BYTES_SOFT_LIMIT and progressive disclosure on the MCP side.
 */
export const MAX_TOOLS_PER_APP = 500;

/**
 * Soft count threshold (#109): from here on registration still succeeds but
 * warns, naming the count, the cap and the headroom, so an app team sees the
 * limit coming in the deploy log long before a push fails at MAX_TOOLS_PER_APP.
 * 80 % of the cap.
 */
export const TOOLS_WARN_THRESHOLD = 400;
/** A scheduled action is deliberately scarce: each is unattended platform work. */
export const MAX_SCHEDULED_ACTIONS_PER_APP = 5;

/**
 * What a manifest costs the model, not the database (#117).
 *
 * The cap counts tools; the cost is bytes. And the bytes that matter are the ones an
 * MCP session publishes per tool — name, description and the params schema. SQL,
 * `operation`, `requires_auth` and `auth` never reach the model (`tool-loader.ts`
 * registers name + description + a zod shape built from `params`), so they are
 * excluded here on purpose: measuring the stored manifest overstates the cost by
 * roughly 60% (chess-academy: 115 kB stored vs ~73 kB on the wire).
 *
 * `estimatedTokens` is the usual ~4-bytes-per-token rule of thumb — good enough to
 * make a 120-tool manifest's per-call occupancy visible at registration, which is the
 * point; it is not a tokenizer.
 */
export function measureManifestCost(tools: ToolManifest[]): { bytes: number; bytesPerTool: number; estimatedTokens: number } {
  const enc = new TextEncoder();
  let bytes = 0;
  for (const tool of tools) {
    const modelFacing = { name: tool.name, description: tool.description, params: tool.params ?? {} };
    bytes += enc.encode(JSON.stringify(modelFacing)).byteLength;
  }
  return {
    bytes,
    bytesPerTool: tools.length ? Math.round(bytes / tools.length) : 0,
    estimatedTokens: Math.round(bytes / 4),
  };
}

/** Where a manifest comes from: the repo's mcp.json, or a console-defined endpoint (#155). */
export type ToolSource = 'code' | 'console';

function validateManifest(tool: ToolManifest, opts: { source: ToolSource } = { source: 'code' }): string | null {
  if (!tool.name || typeof tool.name !== 'string') return 'name is required';
  if (tool.core !== undefined && typeof tool.core !== 'boolean') return 'core must be a boolean';
  if (!/^[a-z][a-z0-9_]*$/.test(tool.name)) return 'name must be lowercase alphanumeric with underscores';
  // Console-defined endpoints own the api_ namespace (#155): a code tool can never
  // shadow one, and a console endpoint can never take a code name — including the
  // can_* names routes/auth.ts consults as permission oracles.
  if (opts.source === 'code' && tool.name.startsWith(ENDPOINT_NAME_PREFIX)) {
    return `the ${ENDPOINT_NAME_PREFIX} prefix is reserved for console-defined endpoints`;
  }
  if (!tool.description || typeof tool.description !== 'string') return 'description is required';
  if (!['query', 'execute', 'batch', 'verify'].includes(tool.operation)) {
    return 'operation must be "query", "execute", "batch" or "verify"';
  }
  if (tool.requires_auth !== true && tool.requires_auth !== false) return 'requires_auth must be explicitly true or false';
  if (tool.verifier !== undefined && tool.operation !== 'verify') return 'only verify tools may declare a verifier';

  // Every statement the tool will run, with the kind it is validated as.
  let checks: { sql: string; kind: 'query' | 'execute' }[];
  if (tool.operation === 'verify') {
    // A verify tool (#148): a scoped SELECT feeds a platform-vetted verifier;
    // optional writes then run with the verdict bound as :__verify_<output>.
    if (tool.requires_auth !== true) return 'verify tools must require auth';
    if (typeof tool.verifier !== 'string' || !getVerifier(tool.verifier)) {
      return `verifier must be one of: ${Object.keys(VERIFIERS).join(', ')}`;
    }
    if (!tool.sql || typeof tool.sql !== 'string') return 'verify tools require sql (the SELECT that feeds the verifier)';
    if (tool.statements !== undefined) {
      if (!Array.isArray(tool.statements)) return 'statements must be an array';
      if (tool.statements.length > 25) return 'max 25 statements per verify tool';
      if (tool.statements.some((s) => !s || typeof s !== 'string')) return 'every statement must be a non-empty string';
    }
    if (new RegExp(`:${VERIFY_PARAM_PREFIX}`).test(tool.sql)) return 'the verify input sql cannot reference :__verify_* (the verifier has not run yet)';
    checks = [{ sql: tool.sql, kind: 'query' }, ...(tool.statements ?? []).map((sql) => ({ sql, kind: 'execute' as const }))];
  } else if (tool.operation === 'batch') {
    if (tool.sql !== undefined) return 'batch tools use statements, not sql';
    if (!Array.isArray(tool.statements) || tool.statements.length === 0) {
      return 'batch tools require a non-empty statements array';
    }
    if (tool.statements.length > 25) return 'max 25 statements per batch tool';
    if (tool.statements.some((s) => !s || typeof s !== 'string')) {
      return 'every statement must be a non-empty string';
    }
    // Batch member statements are writes (queries have nowhere to return).
    checks = tool.statements.map((sql) => ({ sql, kind: 'execute' }));
  } else {
    if (tool.statements !== undefined) return 'only batch and verify tools may declare statements';
    if (!tool.sql || typeof tool.sql !== 'string') return 'sql is required';
    checks = [{ sql: tool.sql, kind: tool.operation }];
  }
  const sqlStatements = checks.map((c) => c.sql);

  for (const { sql, kind } of checks) {
    const sqlErr = validateSql(sql, kind);
    if (sqlErr) return sqlErr;
  }

  if (tool.requires_auth === false) {
    if (tool.operation !== 'query') return 'requires_auth false is only allowed for query tools';
    const sql = sqlStatements[0] ?? '';
    if (/:__user_id\b/.test(sql)) return 'public query tools must not reference :__user_id';
    const limit = literalLimit(sql);
    if (limit === null) return 'public query tools must include a literal LIMIT of 500 or less';
    if (limit > 500) return 'public query tools must use LIMIT 500 or less';
  }
  if (tool.cache_ttl !== undefined) {
    // A cached response is served to every caller, so only a public query may declare one (PAS-DATA-020).
    if (tool.requires_auth !== false || tool.operation !== 'query') return 'cache_ttl is only allowed on public (requires_auth false) query tools';
    if (!Number.isInteger(tool.cache_ttl) || tool.cache_ttl < 1 || tool.cache_ttl > 300) return 'cache_ttl must be an integer from 1 to 300 seconds';
  }

  // params must be an object (default to empty)
  if (tool.params !== undefined && tool.params !== null && typeof tool.params !== 'object') {
    return 'params must be an object';
  }
  const params = tool.params || {};

  // All :paramName in SQL must be declared in params (except magic params). A
  // verify tool's writes may also bind the verifier's declared outputs.
  const magicParams = new Set(['__user_id', '__now', '__uuid']);
  if (tool.operation === 'verify') {
    for (const key of Object.keys(getVerifier(tool.verifier)!.outputs)) magicParams.add(`${VERIFY_PARAM_PREFIX}${key}`);
  }
  const sqlParams = sqlStatements.flatMap((stmt) =>
    [...stmt.matchAll(/:([a-zA-Z_][a-zA-Z0-9_]*)/g)].map(m => m[1]!!),
  );
  const declaredParams = new Set([...Object.keys(params), ...magicParams]);
  for (const p of sqlParams) {
    if (!declaredParams.has(p)) {
      return tool.operation === 'verify' && p.startsWith(VERIFY_PARAM_PREFIX)
        ? `SQL references :${p} but verifier "${tool.verifier}" has no output "${p.slice(VERIFY_PARAM_PREFIX.length)}"`
        : `SQL references :${p} but it is not declared in params`;
    }
  }

  if (tool.auth !== undefined) {
    if (tool.auth === null || typeof tool.auth !== 'object' || Array.isArray(tool.auth)) {
      return 'auth must be an object';
    }
    if (tool.auth.platform_roles !== undefined && !isStringArray(tool.auth.platform_roles)) {
      return 'auth.platform_roles must be an array of strings';
    }
    if (tool.auth.app_roles !== undefined && !isStringArray(tool.auth.app_roles)) {
      return 'auth.app_roles must be an array of strings';
    }
    if (tool.requires_auth === false && (tool.auth.platform_roles?.length || tool.auth.app_roles?.length)) {
      return 'public query tools cannot declare auth roles';
    }
    if (tool.requires_auth === false && tool.auth.required === true) {
      return 'public query tools cannot require auth';
    }
    if (tool.auth.required === false && tool.requires_auth !== false) {
      return 'auth.required cannot be false for app data tools';
    }
  }

  if (tool.schedule !== undefined) {
    if (tool.operation !== 'execute' && tool.operation !== 'batch') return 'schedule is only allowed on execute or batch tools';
    if (tool.requires_auth !== true) return 'scheduled tools must require auth';
    if (typeof tool.auth?.caller_unscoped?.reason !== 'string' || !tool.auth.caller_unscoped.reason.trim()) {
      return 'scheduled tools must declare a non-empty auth.caller_unscoped.reason';
    }
    const schedule = tool.schedule;
    if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) return 'schedule must be an object';
    if (typeof schedule.cron !== 'string' || !validScheduledCron(schedule.cron)) {
      return 'schedule.cron must be a valid five-field UTC cron with a minimum interval of five minutes';
    }
    if (!schedule.params || typeof schedule.params !== 'object' || Array.isArray(schedule.params)) {
      return 'schedule.params must be an object';
    }
    for (const key of Object.keys(schedule.params)) {
      if (!(key in params)) return `schedule.params references undeclared param "${key}"`;
    }
    try {
      // Defaults and optional params are deterministic fixed values too; required
      // params must be supplied or this throws exactly as a real invocation would.
      resolveToolParams(tool, schedule.params);
    } catch (e) {
      return `schedule.params are invalid: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  return null;
}

/**
 * The scheduler understands numeric five-field UTC cron only. Keeping the
 * grammar deliberately compact means the validation and executor cannot drift:
 * wildcard, lists, ranges and steps are enough for normal maintenance jobs.
 */
const CRON_FIELD_LIMITS: ReadonlyArray<readonly [number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];

function cronFieldValues(raw: string, min: number, max: number): number[] | null {
  const values = new Set<number>();
  for (const part of raw.split(',')) {
    if (!part) return null;
    const [base, stepText] = part.split('/');
    if (part.split('/').length > 2 || !base) return null;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1 || step > max - min + 1) return null;
    let start: number;
    let end: number;
    if (base === '*') { start = min; end = max; }
    else if (/^\d+$/.test(base)) { start = end = Number(base); }
    else {
      const match = /^(\d+)-(\d+)$/.exec(base);
      if (!match) return null;
      start = Number(match[1]); end = Number(match[2]);
    }
    if (start < min || end > max || start > end) return null;
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return [...values].sort((a, b) => a - b);
}

/** Five-field numeric cron whose minute set never fires less than five minutes apart. */
export function validScheduledCron(cron: string): boolean {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const values = fields.map((field, i) => cronFieldValues(field, CRON_FIELD_LIMITS[i]![0], CRON_FIELD_LIMITS[i]![1]));
  if (values.some((v) => v === null)) return false;
  const minutes = values[0]!;
  for (let i = 0; i < minutes.length; i++) {
    const next = i + 1 < minutes.length ? minutes[i + 1]! : minutes[0]! + 60;
    if (next - minutes[i]! < 5) return false;
  }
  return true;
}

/** Does this validated five-field cron match a UTC minute? DOM/DOW follow the
 * conventional cron OR rule when both fields are restricted. */
export function scheduledCronMatches(cron: string, timestamp: number): boolean {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const values = fields.map((field, i) => cronFieldValues(field, CRON_FIELD_LIMITS[i]![0], CRON_FIELD_LIMITS[i]![1]));
  if (values.some((v) => v === null)) return false;
  const date = new Date(timestamp);
  const minute = date.getUTCMinutes();
  const hour = date.getUTCHours();
  const day = date.getUTCDate();
  const month = date.getUTCMonth() + 1;
  const weekday = date.getUTCDay();
  if (!values[0]!.includes(minute) || !values[1]!.includes(hour) || !values[3]!.includes(month)) return false;
  const domRestricted = fields[2] !== '*';
  const dowRestricted = fields[4] !== '*';
  const dom = values[2]!.includes(day);
  const dow = values[4]!.includes(weekday);
  return domRestricted && dowRestricted ? dom || dow : dom && dow;
}

/** Every SQL statement a tool runs, in order: batch members; a verify tool's input SELECT then its writes; else the one `sql`. */
export function toolStatements(tool: ToolManifest): string[] {
  if (tool.operation === 'batch') return tool.statements ?? [];
  if (tool.operation === 'verify') return [tool.sql ?? '', ...(tool.statements ?? [])];
  return [tool.sql ?? ''];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim() !== '');
}

/**
 * Schema coherence (#33 Phase 2): compile every action's SQL against the app's
 * LIVE schema (data worker `/validate` → `EXPLAIN`, no execution) so an action
 * that references a table/column that doesn't exist is caught at registration —
 * the deploy fails loud, naming the tool + column, instead of users hitting
 * `no such column` at runtime. Phase 1 applies migrations before this runs, so
 * the schema checked here is current.
 *
 * Hard-blocks ONLY on a definitive `no such column` / `no such table`. Any other
 * outcome — data worker unreachable, unexpected EXPLAIN error — SKIPS silently
 * and lets registration proceed, so transient infra never bricks a deploy
 * (defense-in-depth, not a new single point of failure).
 */
export async function checkSchemaCoherence(
  env: Env,
  appId: string,
  tools: ToolManifest[],
): Promise<string[]> {
  // Flatten to individually-compilable statements, id'd back to their tool.
  const statements: { id: string; tool: string; sql: string; paramCount: number }[] = [];
  for (const tool of tools) {
    const raws = toolStatements(tool);
    raws.forEach((raw, i) => {
      let paramCount = 0;
      const sql = raw.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, () => { paramCount += 1; return '?'; });
      statements.push({ id: `${tool.name}#${i}`, tool: tool.name, sql, paramCount });
    });
  }
  if (statements.length === 0) return [];

  // Internal call: straight to the worker's workers.dev host (#153), not the
  // public data-* proxy hop. A missing DATA_WORKER_HOST throws a 503 here on
  // purpose — silently skipping validation would hide a platform misconfig.
  const validateUrl = dataWorkerUrl(env, appId, '/validate');
  let results: { id: string; ok: boolean; error?: string }[];
  try {
    const res = await fetch(validateUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(env.INTERNAL_TOKEN ? { 'X-Internal-Token': env.INTERNAL_TOKEN } : {}),
      },
      body: JSON.stringify({ statements: statements.map(({ id, sql, paramCount }) => ({ id, sql, paramCount })) }),
    });
    if (!res.ok) return []; // couldn't validate — skip silently, don't block
    const data = await res.json() as { results?: typeof results };
    results = data.results ?? [];
  } catch {
    return []; // unreachable — skip silently
  }

  const toolById = new Map(statements.map((s) => [s.id, s.tool]));
  const errors: string[] = [];
  for (const r of results) {
    if (r.ok) continue;
    const err = r.error ?? '';
    // Only a definitive schema-existence failure blocks; anything else (custom
    // function, EXPLAIN quirk) is not proof of drift, so leave it to runtime.
    const m = /no such (column|table):?\s*([^\s]+)?/i.exec(err);
    if (m) {
      const tool = toolById.get(r.id) ?? r.id;
      errors.push(`tool "${tool}": ${m[0]}`);
    }
  }
  return errors;
}

/**
 * Validate a tools[] manifest and replace the app's registered tools (atomic
 * DELETE + INSERT). Shared by the owner-auth PUT (CLI `pas publish`) and the
 * internal POST (Agent Teams deploy stage). When `env` is supplied, also runs a
 * schema-coherence check (#33) that blocks registration if an action references
 * a missing table/column. Returns a status + payload the caller hands back as JSON.
 */
/**
 * Everything a tool set must pass before it is persisted — manifest rules, the
 * :__user_id scoping lint and the schema-coherence check — shared by code
 * registration (mcp.json) and console-defined endpoints (#155), so a generator
 * bug is rejected by the same code that rejects a bad mcp.json. Resolves null
 * when the set is valid, otherwise the status + payload to answer with
 * (400 lint, 422 coherence).
 */
export async function validateToolSet(
  tools: ToolManifest[],
  env: Env | undefined,
  appId: string,
  opts: { source: ToolSource } = { source: 'code' },
): Promise<{ status: number; payload: Record<string, unknown> } | null> {
  const scheduled = tools.filter((tool) => tool.schedule !== undefined);
  if (scheduled.length > MAX_SCHEDULED_ACTIONS_PER_APP) {
    return { status: 400, payload: { error: `too many scheduled actions: received ${scheduled.length}, max ${MAX_SCHEDULED_ACTIONS_PER_APP} per app` } };
  }
  for (const tool of tools) {
    const err = validateManifest(tool, opts);
    if (err) return { status: 400, payload: { error: `tool "${tool?.name}": ${err}` } };
  }

  // Security lint: every statement of an authenticated tool — reads included —
  // must be scoped to the caller via :__user_id, or the tool must declare an
  // explicit auth.caller_unscoped exemption (with a non-empty reason string).
  // An unscoped read lets any signed-in user read every tenant's rows. Public
  // (requires_auth: false) tools are exempt. Failure is a hard rejection, not a
  // warning, so a misconfigured tool cannot be registered at all.
  const scopeErrors: string[] = [];
  for (const tool of tools) {
    if (tool.requires_auth === false) continue; // public query path — no user identity expected
    const hasCallerUnscoped =
      typeof tool.auth?.caller_unscoped?.reason === 'string' &&
      tool.auth.caller_unscoped.reason.trim().length > 0;
    if (hasCallerUnscoped) continue;
    const stmts = toolStatements(tool);
    stmts.forEach((stmt, idx) => {
      if (!stmt.includes(':__user_id')) {
        const location =
          stmts.length > 1 ? `"${tool.name}" statement[${idx}]` : `"${tool.name}"`;
        scopeErrors.push(
          `${location}: statement has no :__user_id and no auth.caller_unscoped exemption`,
        );
      }
    });
  }
  if (scopeErrors.length > 0) {
    return {
      status: 400,
      payload: {
        error: 'statements must include :__user_id or declare auth.caller_unscoped',
        details: scopeErrors,
      },
    };
  }

  // Schema coherence (#33): reject actions whose SQL references a missing
  // table/column, before we persist them. Runs against the just-migrated schema
  // (Phase 1 migrates before register). Skipped when env is absent (direct unit
  // tests of this fn) or when the check can't reach the data worker.
  if (env) {
    const coherenceErrors = await checkSchemaCoherence(env, appId, tools);
    if (coherenceErrors.length > 0) {
      return {
        status: 422,
        payload: {
          error: `schema coherence: ${coherenceErrors.length} action(s) reference schema that doesn't exist`,
          details: coherenceErrors,
        },
      };
    }
  }
  return null;
}

/** The non-tool parts of an app's mcp.json that register with it (#210). */
export interface SiteManifest {
  page_meta?: unknown;
  sitemap?: unknown;
}

interface PageMetaRoute { path: string; action: string; param: string }

export const MAX_PAGE_META_ROUTES = 20;
const PATH_LITERAL = /^[A-Za-z0-9._~-]+$/;
const PATH_PARAM = /^:([a-z_][a-z0-9_]*)$/;

/**
 * Light check that a query's SELECT list outputs `name`: as an alias (`x AS name`)
 * or a bare / table-qualified column (`name`, `p.name`) followed by `,` or FROM.
 * Not a SQL parser — the host tolerates a missing field at runtime (fail-open).
 */
export function selectsColumn(sql: string, name: string): boolean {
  const code = sql.replace(/'(?:[^']|'')*'/g, "''");
  return new RegExp(String.raw`(?:\bAS\s+["\x60]?${name}["\x60]?|[\s.,(]${name})\s*(?:,|\bFROM\b)`, 'i').test(code);
}

/** A public query action in this manifest, or why the reference is refused. */
function publicQueryAction(tools: ToolManifest[], action: unknown, where: string): ToolManifest | string {
  if (typeof action !== 'string' || !action) return `${where}: action is required`;
  const tool = tools.find((t) => t.name === action);
  if (!tool) return `${where}: action "${action}" is not a tool in this manifest`;
  if (tool.requires_auth !== false || tool.operation !== 'query') {
    return `${where}: action "${action}" must be a public query (requires_auth false) — link previews and crawlers are signed out`;
  }
  return tool;
}

/** Validate `page_meta` and `sitemap` against the (already validated) tools. */
function validateSiteManifest(
  tools: ToolManifest[],
  site: SiteManifest,
): { error: string } | { routes: PageMetaRoute[]; sitemap: string | null } {
  const routes: PageMetaRoute[] = [];
  const pageMeta = site.page_meta ?? [];
  if (!Array.isArray(pageMeta)) return { error: 'page_meta must be an array' };
  if (pageMeta.length > MAX_PAGE_META_ROUTES) return { error: `page_meta: max ${MAX_PAGE_META_ROUTES} routes` };
  const seen = new Set<string>();
  for (const [i, raw] of pageMeta.entries()) {
    const where = `page_meta[${i}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: `${where} must be an object` };
    const { path, action, param } = raw as Record<string, unknown>;
    if (typeof path !== 'string' || path.length > 200 || !path.startsWith('/')) return { error: `${where}: path must start with / (max 200 chars)` };
    if (typeof param !== 'string' || !param) return { error: `${where}: param is required` };
    const segments = path.split('/').slice(1);
    const placeholders = segments.map((seg) => PATH_PARAM.exec(seg)?.[1]).filter((name): name is string => Boolean(name));
    if (segments.some((seg) => !PATH_LITERAL.test(seg) && !PATH_PARAM.test(seg))) {
      return { error: `${where}: path segments are literals ([A-Za-z0-9._~-]) or one :placeholder` };
    }
    if (placeholders.length !== 1 || placeholders[0] !== param) return { error: `${where}: path must contain exactly one placeholder, :${param}` };
    if (seen.has(path)) return { error: `${where}: duplicate path ${path}` };
    seen.add(path);
    const tool = publicQueryAction(tools, action, where);
    if (typeof tool === 'string') return { error: tool };
    if (!tool.params?.[param]) return { error: `${where}: action "${tool.name}" does not declare param "${param}"` };
    const missing = ['title', 'description', 'image_url'].filter((col) => !selectsColumn(tool.sql ?? '', col));
    if (missing.length) return { error: `${where}: action "${tool.name}" must select ${missing.join(', ')}` };
    routes.push({ path, action: tool.name, param });
  }

  if (site.sitemap === undefined || site.sitemap === null) return { routes, sitemap: null };
  if (typeof site.sitemap !== 'object' || Array.isArray(site.sitemap)) return { error: 'sitemap must be an object' };
  const tool = publicQueryAction(tools, (site.sitemap as Record<string, unknown>).action, 'sitemap');
  if (typeof tool === 'string') return { error: tool };
  if (!tool.params?.cursor) return { error: `sitemap: action "${tool.name}" must declare a cursor param (keyset paging: WHERE path > :cursor ORDER BY path)` };
  const missing = ['path', 'updated_at'].filter((col) => !selectsColumn(tool.sql ?? '', col));
  if (missing.length) return { error: `sitemap: action "${tool.name}" must select ${missing.join(', ')}` };
  return { routes, sitemap: tool.name };
}

export async function replaceAppTools(
  db: D1Database,
  appId: string,
  tools: unknown,
  env?: Env,
  site: SiteManifest = {},
): Promise<{ status: number; payload: Record<string, unknown> }> {
  if (!tools || !Array.isArray(tools)) {
    return { status: 400, payload: { error: 'tools array required' } };
  }
  // Abuse bound, not a design target. Data-heavy apps register one tool per
  // parameterized statement (chess-academy needs ~80, a real CRM/ERP surface
  // crosses 120), so the cap sits well above any legitimate manifest (#116).
  // Payload size is bounded separately by the byte-cost soft warning above.
  // Counts the submitted code tools only; console endpoints have their own cap.
  if (tools.length > MAX_TOOLS_PER_APP) {
    return {
      status: 400,
      payload: { error: `too many tools: received ${tools.length}, max ${MAX_TOOLS_PER_APP} per app` },
    };
  }
  const invalid = await validateToolSet(tools as ToolManifest[], env, appId, { source: 'code' });
  if (invalid) return invalid;
  const siteResult = validateSiteManifest(tools as ToolManifest[], site);
  if ('error' in siteResult) return { status: 400, payload: { error: siteResult.error } };

  // A deploy replaces the CODE tools only (#155): console-defined endpoints live
  // in the same table under source = 'console' and are never touched here — a
  // push with no mcp.json clears the code set and leaves the console's work.
  const now = Date.now();
  const stmts = [
    db.prepare("DELETE FROM app_tools WHERE app_id = ? AND source = 'code'").bind(appId),
    // Re-registration is the explicit breaker reset: a deploy confirms that
    // the owner reviewed the manifest before unattended work resumes.
    db.prepare("DELETE FROM scheduled_action_state WHERE app_id = ? AND source = 'code'").bind(appId),
    ...(tools as ToolManifest[]).map(tool =>
      db.prepare(
        "INSERT INTO app_tools (app_id, name, manifest, created_at, updated_at, source) VALUES (?, ?, ?, ?, ?, 'code')",
      ).bind(appId, tool.name, JSON.stringify(tool), now, now),
    ),
    // Page meta and sitemap are part of the manifest (#210): replaced with it,
    // so they can never name an action the app no longer registers.
    db.prepare('DELETE FROM app_page_meta WHERE app_id = ?').bind(appId),
    db.prepare('DELETE FROM app_sitemap WHERE app_id = ?').bind(appId),
    ...siteResult.routes.map((r, i) =>
      db.prepare(
        'INSERT INTO app_page_meta (app_id, position, path_pattern, action_name, param_name, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).bind(appId, i, r.path, r.action, r.param, now),
    ),
    ...(siteResult.sitemap
      ? [db.prepare('INSERT INTO app_sitemap (app_id, action_name, created_at) VALUES (?, ?, ?)').bind(appId, siteResult.sitemap, now)]
      : []),
  ];
  await db.batch(stmts);

  // Report the model-facing cost beside the count (#117). A soft warning above the
  // threshold — never a rejection: the deploy workflow prints `warnings[]` as
  // `::warning::mcp.json: …`, so the author sees the number where the deploy is.
  const cost = measureManifestCost(tools as ToolManifest[]);
  const schedules = (tools as ToolManifest[])
    .filter((tool) => tool.schedule)
    .map((tool) => ({ name: tool.name, cron: tool.schedule!.cron }));
  if (schedules.length) console.log(`[schedule] registered app=${appId} ${schedules.map((s) => `${s.name}@${s.cron}`).join(', ')}`);
  const warnings: string[] =
    cost.bytes > MANIFEST_BYTES_SOFT_LIMIT
      ? [
          `Manifest model-facing payload is ${cost.bytes} bytes (~${cost.estimatedTokens} tokens) across ${tools.length} tool(s); ` +
            'every MCP session on this app carries it in context on every call — consider slimming descriptions or adopting progressive disclosure',
        ]
      : [];
  // Count headroom (#109): a second, independent warning as the manifest nears
  // the hard cap, so the limit is announced while there is still room to plan.
  if (tools.length >= TOOLS_WARN_THRESHOLD) {
    warnings.push(
      `Manifest registers ${tools.length} of ${MAX_TOOLS_PER_APP} tools (${Math.round((tools.length / MAX_TOOLS_PER_APP) * 100)}% of the per-app cap, ${MAX_TOOLS_PER_APP - tools.length} left); ` +
        'registration fails above the cap — consolidate near-duplicate actions (one list_* with optional filters instead of one per column), ' +
        'or open a platform issue with these numbers to raise the cap for this app (docs: mcp-app-tools → Budgeting for larger apps)',
    );
  }
  return {
    status: 200,
    payload: { ok: true, registered: tools.length, ...cost, schedules, page_meta: siteResult.routes.length, sitemap: siteResult.sitemap !== null, warnings },
  };
}

// ── PUT /v1/apps/:appId/tools — bulk register tools from mcp.json ──
toolsRoutes.put('/apps/:appId/tools', async (c) => {
  const appId = c.req.param('appId')!;
  await requireAppOwner(c, appId);

  const body = await c.req.json<{ tools?: ToolManifest[] } & SiteManifest>().catch(() => null);
  const { status, payload } = await replaceAppTools(c.env.DB, appId, body?.tools, c.env, { page_meta: body?.page_meta, sitemap: body?.sitemap });
  return c.json(payload, status as 200 | 400 | 422);
});

// ── POST /v1/apps/:appId/tools/internal — register tools service-to-service ──
// Called by the Agent Teams deploy stage over the PAS_BACKEND binding so
// agent-built apps register their mcp.json the same way `pas publish` does for
// CLI apps. Auth is the shared INTERNAL_TOKEN (the agent flow has no session).
// An empty/missing tools array clears the app's tools (the manifest was removed).
toolsRoutes.post('/apps/:appId/tools/internal', async (c) => {
  if (!internalTokenOk(c.req.header('X-Internal-Token'), c.env.INTERNAL_TOKEN)) {
    return c.json({ error: 'forbidden' }, 403);
  }
  const appId = c.req.param('appId')!;
  if (!/^[a-z][a-z0-9-]*$/.test(appId) || appId.length > 58) {
    return c.json({ error: 'invalid app id' }, 400);
  }
  const body = await c.req.json<{ tools?: ToolManifest[] } & SiteManifest>().catch(() => null);
  const { status, payload } = await replaceAppTools(c.env.DB, appId, body?.tools ?? [], c.env, { page_meta: body?.page_meta, sitemap: body?.sitemap });
  return c.json(payload, status as 200 | 400 | 422);
});

/**
 * SECURITY (#158): what an unauthenticated caller may see of a manifest —
 * everything needed to CALL a tool, never how it is implemented. The SQL is
 * the app's authorization model (docs/mcp-app-tools.md), and app repos are
 * private, so it goes only to the app's team.
 *
 * An allowlist, not a `delete m.sql` denylist: a field added to the manifest
 * later (statements, auth.caller_unscoped.reason) is private until listed here.
 */
function publicToolView(m: ToolManifest) {
  return {
    name: m.name,
    description: m.description,
    operation: m.operation,
    // The platform verifier a verify tool runs (#148) — a public module id, not app SQL.
    ...(m.verifier !== undefined ? { verifier: m.verifier } : {}),
    params: m.params,
    requires_auth: m.requires_auth,
    // Which tools stay resident on a large app's MCP session (#117) — not sensitive.
    ...(m.core !== undefined ? { core: m.core } : {}),
    // Only that one is scheduled, so MCP can hide it (#203) — never its cron or fixed params.
    ...(m.schedule !== undefined ? { scheduled: true } : {}),
    ...(m.auth
      ? { auth: { required: m.auth.required, platform_roles: m.auth.platform_roles, app_roles: m.auth.app_roles } }
      : {}),
  };
}

// ── GET /v1/apps/:appId/tools — list tools for one app ──────────
//
// Public: names, descriptions, params (the MCP's per-app session calls this
// with no credential and never reads the SQL). Full manifests, SQL included,
// only for the app's team — creator, any team_members role, or a platform
// admin — which is what the console's "show SQL" sends a bearer for.
toolsRoutes.get('/apps/:appId/tools', async (c) => {
  const appId = c.req.param('appId')!;
  const teamMember = await requireAppAccess(c, appId, 'viewer').then(() => true, () => false);

  // `source` tells the console which rows are code (mcp.json) and which are its
  // own endpoints (#155). The console `config` column is never listed here.
  const result = await c.env.DB.prepare(
    'SELECT name, manifest, updated_at, source FROM app_tools WHERE app_id = ? ORDER BY name',
  ).bind(appId).all<{ name: string; manifest: string; updated_at: number; source: ToolSource | null }>();

  const tools: unknown[] = [];
  for (const r of result.results ?? []) {
    let manifest: ToolManifest;
    try {
      manifest = JSON.parse(r.manifest);
    } catch { continue; /* skip corrupted row */ }
    const source: ToolSource = r.source === 'console' ? 'console' : 'code';
    tools.push(
      teamMember
        ? { ...manifest, updated_at: r.updated_at, source }
        : { ...publicToolView(manifest), updated_at: r.updated_at, source },
    );
  }

  // The full variant is per-caller; no cache layer may hand it to anyone else.
  if (teamMember) c.header('Cache-Control', 'private, no-store');
  return c.json({ tools });
});

// ── DELETE /v1/apps/:appId/tools — remove all tools for an app ──
toolsRoutes.delete('/apps/:appId/tools', async (c) => {
  const appId = c.req.param('appId')!;
  await requireAppOwner(c, appId);
  // Code rows only: console endpoints are removed through the audited endpoints route (#155).
  // Page meta and sitemap go with the code manifest that declared them (#210).
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM app_tools WHERE app_id = ? AND source = 'code'").bind(appId),
    c.env.DB.prepare('DELETE FROM app_page_meta WHERE app_id = ?').bind(appId),
    c.env.DB.prepare('DELETE FROM app_sitemap WHERE app_id = ?').bind(appId),
  ]);
  return c.json({ ok: true });
});

// ── DELETE /v1/apps/:appId/tools/:name — remove one tool ─────────
toolsRoutes.delete('/apps/:appId/tools/:name', async (c) => {
  const appId = c.req.param('appId')!;
  const name = c.req.param('name')!;
  await requireAppOwner(c, appId);
  await c.env.DB.prepare("DELETE FROM app_tools WHERE app_id = ? AND name = ? AND source = 'code'").bind(appId, name).run();
  return c.json({ ok: true });
});
