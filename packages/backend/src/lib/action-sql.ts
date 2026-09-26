export interface ToolParam {
  type: string;
  description?: string;
  optional?: boolean;
  default?: unknown;
  max?: number;
}

export interface ToolAuth {
  required?: boolean;
  platform_roles?: string[];
  app_roles?: string[];
  /** Registration-time exemption from the :__user_id scoping lint, with the reason. */
  caller_unscoped?: { reason: string };
}

/** Fixed input carried by a platform schedule. Schedules never receive caller input. */
export interface ToolSchedule {
  cron: string;
  params: Record<string, unknown>;
}

export type ToolOperation = 'query' | 'execute' | 'batch' | 'verify';

/** Prefix of the magic placeholders a verify action's write statements bind the verdict through (#148). */
export const VERIFY_PARAM_PREFIX = '__verify_';

export interface ToolManifest {
  name: string;
  description: string;
  /** `verify` (#148): `sql` is a scoped SELECT whose rows feed the platform
   *  verifier named by `verifier`; the optional `statements` then run atomically
   *  with the verdict bound as `:__verify_<output>`. */
  operation: ToolOperation;
  /** Single statement — query/execute tools; the input SELECT of a verify tool. */
  sql?: string;
  /** Multiple statements sharing one params pool — batch tools. Executed
   *  ATOMICALLY (one D1 transaction via the data-worker /batch endpoint), so
   *  multi-step flows (tournament round creation, org create+membership,
   *  cascading deletes) can't be left half-applied by a mid-sequence failure.
   *  On a verify tool: the writes that run after a completed verification. */
  statements?: string[];
  /** Id of the platform-vetted verifier a verify tool runs (lib/verifiers). */
  verifier?: string;
  params: Record<string, ToolParam>;
  requires_auth?: boolean;
  /** Seconds (1–300) the platform may edge-cache a public query's 200 response (#211).
   *  Registration rejects it on any tool a signed-out caller cannot run. */
  cache_ttl?: number;
  auth?: ToolAuth;
  /** Platform-owned periodic execution for an authenticated, explicitly unscoped write. */
  schedule?: ToolSchedule;
  /** Stay pre-loaded on a large app's MCP session instead of being deferred to discovery (#117). */
  core?: boolean;
}

interface PreparedQuery {
  sql: string;
  params: unknown[];
}

export function prepareActionQuery(
  manifest: ToolManifest,
  input: Record<string, unknown>,
  userId: string,
): PreparedQuery {
  if (typeof manifest.sql !== 'string') {
    throw new Error(`tool ${manifest.name} has no sql`);
  }
  return bindStatement(manifest.sql, resolveToolParams(manifest, input), userId);
}

/**
 * Prepare a batch tool: every statement binds against the SAME resolved param
 * pool, so a shared :param (or :__user_id / :__now) is identical across all
 * statements. :__uuid stays per-occurrence — ids that must correlate across
 * statements are client-supplied params.
 */
export function prepareActionBatch(
  manifest: ToolManifest,
  input: Record<string, unknown>,
  userId: string,
): PreparedQuery[] {
  if (!Array.isArray(manifest.statements) || manifest.statements.length === 0) {
    throw new Error(`tool ${manifest.name} has no statements`);
  }
  const resolved = resolveToolParams(manifest, input);
  // One clock reading for the whole batch: a later statement may guard on the
  // timestamp an earlier one wrote (`WHERE updated_at = :__now`), which must not
  // depend on the millisecond ticking over between two occurrences.
  const now = Date.now();
  return manifest.statements.map((sql) => bindStatement(sql, resolved, userId, now));
}

/**
 * Prepare the input SELECT of a verify tool (#148). Verdict placeholders are
 * not available yet — registration refuses them in `sql`.
 */
export function prepareVerifyInput(
  manifest: ToolManifest,
  input: Record<string, unknown>,
  userId: string,
): PreparedQuery {
  if (typeof manifest.sql !== 'string') {
    throw new Error(`tool ${manifest.name} has no sql`);
  }
  return bindStatement(manifest.sql, resolveToolParams(manifest, input), userId);
}

/**
 * Prepare the write statements of a verify tool with the verifier's verdict
 * bound as `:__verify_<output>` (#148). Same pool rules as a batch: shared
 * params and :__now, per-occurrence :__uuid. Returns [] when the tool declares
 * no writes.
 */
export function prepareVerifyWrites(
  manifest: ToolManifest,
  input: Record<string, unknown>,
  userId: string,
  output: Record<string, unknown>,
): PreparedQuery[] {
  if (!Array.isArray(manifest.statements) || manifest.statements.length === 0) return [];
  const resolved = resolveToolParams(manifest, input);
  const verdict = Object.fromEntries(Object.entries(output).map(([k, v]) => [`${VERIFY_PARAM_PREFIX}${k}`, v]));
  const now = Date.now();
  return manifest.statements.map((sql) => bindStatement(sql, resolved, userId, now, verdict));
}

function bindStatement(
  rawSql: string,
  resolved: Record<string, unknown>,
  userId: string,
  now: number = Date.now(),
  extraMagic: Record<string, unknown> = {},
): PreparedQuery {
  const magicValues: Record<string, () => unknown> = {
    __user_id: () => userId,
    __now: () => now,
    __uuid: () => crypto.randomUUID(),
  };
  for (const [name, value] of Object.entries(extraMagic)) magicValues[name] = () => value;

  const names: string[] = [];
  const sql = rawSql.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_match, name: string) => {
    names.push(name);
    return '?';
  });

  const params = names.map((name) => {
    if (name in magicValues) return magicValues[name]!();
    if (name in resolved) return resolved[name];
    throw new Error(`Unresolved parameter: ${name}`);
  });

  return { sql, params };
}

/** Resolve and type-check an action input. Registration uses this for the
 * schedule's fixed params; runtime preparation uses the exact same rules. */
export function resolveToolParams(
  manifest: ToolManifest,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(manifest.params ?? {})) {
    let value = input[name];

    if (value === undefined || value === null) {
      if (schema.default !== undefined) {
        value = schema.default;
      } else if (schema.optional) {
        value = null;
      } else {
        throw new Error(`Missing required parameter: ${name}`);
      }
    }

    if (value !== null) {
      switch (schema.type) {
        case 'integer':
          value = Number(value);
          if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
          if (schema.max !== undefined && (value as number) > schema.max) value = schema.max;
          break;
        case 'number':
          value = Number(value);
          if (Number.isNaN(value)) throw new Error(`${name} must be a number`);
          if (schema.max !== undefined && (value as number) > schema.max) value = schema.max;
          break;
        case 'boolean':
          if (typeof value === 'string') {
            value = value !== '' && value !== '0' && value.toLowerCase() !== 'false' && value.toLowerCase() !== 'no';
          } else {
            value = Boolean(value);
          }
          break;
        default:
          value = String(value);
      }
    }

    resolved[name] = value;
  }

  return resolved;
}
