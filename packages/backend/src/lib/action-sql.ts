export interface ToolParam {
  type: string;
  description?: string;
  optional?: boolean;
  default?: unknown;
  max?: number;
}

interface ToolAuth {
  required?: boolean;
  platform_roles?: string[];
  app_roles?: string[];
  /** Registration-time exemption from the :__user_id scoping lint, with the reason. */
  caller_unscoped?: { reason: string };
}

/** Fixed input carried by a platform schedule. Schedules never receive caller input. */
interface ToolSchedule {
  cron: string;
  params: Record<string, unknown>;
}

type ToolOperation = 'query' | 'execute' | 'batch' | 'verify';

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
  /** Require a recent authentication (session `auth_time` within STEP_UP_MAX_AGE_SECONDS) before
   *  the action runs (#231) — e.g. viewing an ID document. A stale caller gets `step_up_required`. */
  step_up?: boolean;
  /** Who may run the action (#254, ADR-009 §2). Absent means `["user"]`, today's behaviour. */
  callers?: ActionCaller[];
  /**
   * #500: only the signed-in owner in the app's own UI may run it. An MCP agent session (the call arrives marked
   * `X-PAS-Via: mcp`, see {@link MCP_VIA_HEADER}) is refused, and the MCP server does not list it. For actions that post, delete
   * or lock records, where an assistant proposing is fine but acting is not. Absent or false: callable by agents as before.
   */
  owner_ui_only?: boolean;
}

/** The header the MCP server adds to every action call it makes on a user's behalf (#500). Only ever restricts a call. */
export const MCP_VIA_HEADER = 'X-PAS-Via';
export const MCP_VIA_VALUE = 'mcp';

/** #428: a staged action is callable only by the app's owner and team and by platform callers; a live one by anyone its auth admits. */
export type ActionState = 'staged' | 'live';

// 'billing' (#507): the platform's own checkout runs it, to decide who may buy; no session, worker or hook can.
export const ACTION_CALLERS = ['user', 'worker', 'hook', 'billing'] as const;
export type ActionCaller = (typeof ACTION_CALLERS)[number];

/** The action's callers, with the default applied. */
export function actionCallers(manifest: Pick<ToolManifest, 'callers'>): readonly ActionCaller[] {
  return manifest.callers ?? ['user'];
}

/**
 * Light check that a query's SELECT list outputs `name`: as an alias (`x AS name`)
 * or a bare / table-qualified column (`name`, `p.name`) followed by `,` or FROM.
 * Not a SQL parser — the host tolerates a missing field at runtime (fail-open).
 */
export function selectsColumn(sql: string, name: string): boolean {
  const code = sql.replace(/'(?:[^']|'')*'/g, "''");
  return new RegExp(String.raw`(?:\bAS\s+["\x60]?${name}["\x60]?|[\s.,(]${name})\s*(?:,|\bFROM\b)`, 'i').test(code);
}

/** The literal `LIMIT n` of a statement, or null when there is none (or it uses comma syntax). */
export function literalLimit(sql: string): number | null {
  const withoutComments = sql
    .replace(/--.*$/gm, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
  const match = /\bLIMIT\s+(\d+)\b/i.exec(withoutComments);
  if (!match) return null;
  const tail = withoutComments.slice(match.index + match[0].length).trim();
  if (tail.startsWith(',')) return null;
  return Number(match[1]);
}

interface PreparedQuery {
  sql: string;
  params: unknown[];
}

/**
 * Floor below which an integer cannot be a real millisecond epoch (roughly
 * 2001-09-09) — anything smaller is a 10-digit UNIX-seconds value mistakenly
 * sent where milliseconds are expected, which renders as 1970 once displayed
 * (#1395). `timestamp_ms` normalises it instead of storing the wrong date.
 */
const MS_TIMESTAMP_FLOOR = 1_000_000_000_000;
/** Clock-skew allowance for a `timestamp_ms` value — not a feature, just slack. */
const MS_TIMESTAMP_FUTURE_DRIFT = 5 * 60 * 1000;

export function prepareActionQuery(
  manifest: ToolManifest,
  input: Record<string, unknown>,
  userId: string,
  isChild = false,
): PreparedQuery {
  if (typeof manifest.sql !== 'string') {
    throw new Error(`tool ${manifest.name} has no sql`);
  }
  return bindStatement(manifest.sql, resolveToolParams(manifest, input), userId, Date.now(), {}, isChild);
}

/**
 * Whether an action's SQL asks for the caller's child flag (#513). The platform reads the flag from the account record only for an
 * action that uses it, so every other action costs no extra read.
 */
export function referencesChildFlag(manifest: ToolManifest): boolean {
  return [manifest.sql, ...(manifest.statements ?? [])].some((sql) => typeof sql === 'string' && /:__user_is_child\b/.test(sql));
}

/**
 * Prepare a batch tool: every statement binds against the SAME resolved param
 * pool, so a shared :param (or :__user_id / :__user_is_child / :__now) is identical across all
 * statements. :__uuid stays per-occurrence — ids that must correlate across
 * statements are client-supplied params.
 */
export function prepareActionBatch(
  manifest: ToolManifest,
  input: Record<string, unknown>,
  userId: string,
  isChild = false,
): PreparedQuery[] {
  if (!Array.isArray(manifest.statements) || manifest.statements.length === 0) {
    throw new Error(`tool ${manifest.name} has no statements`);
  }
  const resolved = resolveToolParams(manifest, input);
  // One clock reading for the whole batch: a later statement may guard on the
  // timestamp an earlier one wrote (`WHERE updated_at = :__now`), which must not
  // depend on the millisecond ticking over between two occurrences.
  const now = Date.now();
  return manifest.statements.map((sql) => bindStatement(sql, resolved, userId, now, {}, isChild));
}

/**
 * Prepare the input SELECT of a verify tool (#148). Verdict placeholders are
 * not available yet — registration refuses them in `sql`.
 */
export function prepareVerifyInput(
  manifest: ToolManifest,
  input: Record<string, unknown>,
  userId: string,
  isChild = false,
): PreparedQuery {
  return prepareActionQuery(manifest, input, userId, isChild);
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
  isChild = false,
): PreparedQuery[] {
  if (!Array.isArray(manifest.statements) || manifest.statements.length === 0) return [];
  const resolved = resolveToolParams(manifest, input);
  const verdict = Object.fromEntries(Object.entries(output).map(([k, v]) => [`${VERIFY_PARAM_PREFIX}${k}`, v]));
  const now = Date.now();
  return manifest.statements.map((sql) => bindStatement(sql, resolved, userId, now, verdict, isChild));
}

function bindStatement(
  rawSql: string,
  resolved: Record<string, unknown>,
  userId: string,
  now: number = Date.now(),
  extraMagic: Record<string, unknown> = {},
  isChild = false,
): PreparedQuery {
  const magicValues: Record<string, () => unknown> = {
    __user_id: () => userId,
    // #513: 1 for a child account, else 0. Read from the account record by the caller of this function, never from the request: a
    // client-supplied param of the same name is not read, because a magic name is resolved before the request's params.
    __user_is_child: () => (isChild ? 1 : 0),
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
          if (schema.max !== undefined && (value as number) < 0) throw new Error(`${name} must be >= 0`);
          if (schema.max !== undefined && (value as number) > schema.max) value = schema.max;
          break;
        case 'timestamp_ms': {
          const ms = Number(value);
          if (!Number.isInteger(ms)) throw new Error(`${name} must be an integer millisecond epoch timestamp`);
          // A caller that means UNIX seconds sends a value under the millisecond
          // floor; normalise rather than silently storing a 1970 date (#1395).
          const normalised = ms > 0 && ms < MS_TIMESTAMP_FLOOR ? ms * 1000 : ms;
          if (normalised < MS_TIMESTAMP_FLOOR || normalised > Date.now() + MS_TIMESTAMP_FUTURE_DRIFT) {
            throw new Error(`${name} must be a plausible millisecond epoch timestamp`);
          }
          value = normalised;
          break;
        }
        case 'number':
          value = Number(value);
          if (Number.isNaN(value)) throw new Error(`${name} must be a number`);
          if (schema.max !== undefined && (value as number) < 0) throw new Error(`${name} must be >= 0`);
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
