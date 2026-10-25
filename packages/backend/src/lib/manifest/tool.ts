import { ACTION_CALLERS, VERIFY_PARAM_PREFIX, actionCallers, literalLimit, resolveToolParams, type ToolManifest, type ToolParam } from '../action-sql.js';
import { ENDPOINT_NAME_PREFIX } from '../endpoint-sql.js';
import { getVerifier, VERIFIERS } from '../verifiers/index.js';
import { isCronSyntaxError, scheduledCronError } from './cron.js';
import { validateSql } from './sql.js';

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

export function validateManifest(tool: ToolManifest, opts: { source: ToolSource } = { source: 'code' }): string | null {
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

  if (tool.step_up !== undefined) {
    if (typeof tool.step_up !== 'boolean') return 'step_up must be a boolean';
    if (tool.step_up && tool.requires_auth !== true) return 'step_up is only allowed on tools that require auth';
    if (tool.step_up && tool.schedule !== undefined) return 'scheduled tools cannot declare step_up (no one signs in)';
  }
  if (tool.schedule !== undefined) {
    if (tool.operation !== 'execute' && tool.operation !== 'batch') return 'schedule is only allowed on execute or batch tools';
    if (tool.requires_auth !== true) return 'scheduled tools must require auth';
    if (typeof tool.auth?.caller_unscoped?.reason !== 'string' || !tool.auth.caller_unscoped.reason.trim()) {
      return 'scheduled tools must declare a non-empty auth.caller_unscoped.reason';
    }
    const schedule = tool.schedule;
    if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) return 'schedule must be an object';
    if (typeof schedule.cron !== 'string') return 'schedule.cron must be a five-field numeric UTC cron string';
    const cronError = scheduledCronError(schedule.cron);
    if (cronError && isCronSyntaxError(cronError)) return 'schedule.cron must be a valid five-field numeric UTC cron';
    if (cronError) return `schedule.cron ${cronError}`;
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

  // #254 (ADR-009 §2): who may run the action. Absent = ["user"].
  if (tool.callers !== undefined) {
    const callers: unknown = tool.callers;
    if (!Array.isArray(callers) || callers.length === 0 || callers.some((c) => !(ACTION_CALLERS as readonly unknown[]).includes(c))) {
      return `callers must be a non-empty array of ${ACTION_CALLERS.map((c) => `"${c}"`).join(', ')}`;
    }
    if (new Set(callers).size !== callers.length) return 'callers must not repeat a caller';
    if (tool.requires_auth === false && !callers.includes('user')) return 'a public action (requires_auth false) must include "user" in callers';
    if (tool.schedule !== undefined) return 'scheduled tools cannot declare callers (only the platform scheduler runs them)';
  }

  return null;
}

/**
 * #254: an unscoped write that any signed-in user can run. Not refused — some
 * apps mean it — but said out loud at registration, because a write meant for
 * the app's worker usually wants `callers: ["worker"]` instead.
 */
export function openUnscopedWrite(tool: ToolManifest): boolean {
  return (tool.operation === 'execute' || tool.operation === 'batch')
    && tool.requires_auth !== false
    && tool.schedule === undefined
    && tool.auth?.caller_unscoped !== undefined
    && !tool.auth.app_roles?.length && !tool.auth.platform_roles?.length
    && actionCallers(tool).includes('user');
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim() !== '');
}
