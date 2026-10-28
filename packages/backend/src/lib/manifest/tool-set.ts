import { writesReservedTable } from '../../../../data-worker/src/reserved-tables.js';
import type { Env } from '../../types.js';
import type { ToolManifest } from '../action-sql.js';
import { dataWorkerUrl } from '../data-worker-url.js';
import { MAX_SCHEDULED_ACTIONS_PER_APP, validateManifest, type ToolSource } from './tool.js';

/** Every SQL statement a tool runs, in order: batch members; a verify tool's input SELECT then its writes; else the one `sql`. */
export function toolStatements(tool: ToolManifest): string[] {
  if (tool.operation === 'batch') return tool.statements ?? [];
  if (tool.operation === 'verify') return [tool.sql ?? '', ...(tool.statements ?? [])];
  return [tool.sql ?? ''];
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

  // #508: `_pas_*` tables are the platform's (the entitlement mirror). An action may read them and JOIN them; it may not write one,
  // or an app could grant itself any entitlement.
  for (const tool of tools) {
    for (const [i, stmt] of toolStatements(tool).entries()) {
      const reserved = writesReservedTable(stmt);
      if (reserved) return { status: 400, payload: { error: `tool "${tool.name}": statement ${i + 1} writes ${reserved}; _pas_* tables are platform-owned and read-only for apps` } };
    }
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
