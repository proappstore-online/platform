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
}

export interface ToolManifest {
  name: string;
  description: string;
  operation: 'query' | 'execute' | 'batch';
  /** Single statement — query/execute tools. */
  sql?: string;
  /** Multiple statements sharing one params pool — batch tools. Executed
   *  ATOMICALLY (one D1 transaction via the data-worker /batch endpoint), so
   *  multi-step flows (tournament round creation, org create+membership,
   *  cascading deletes) can't be left half-applied by a mid-sequence failure. */
  statements?: string[];
  params: Record<string, ToolParam>;
  requires_auth?: boolean;
  auth?: ToolAuth;
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
  return bindStatement(manifest.sql, resolveParams(manifest, input), userId);
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
  const resolved = resolveParams(manifest, input);
  return manifest.statements.map((sql) => bindStatement(sql, resolved, userId));
}

function bindStatement(
  rawSql: string,
  resolved: Record<string, unknown>,
  userId: string,
): PreparedQuery {
  const magicValues: Record<string, () => unknown> = {
    __user_id: () => userId,
    __now: () => Date.now(),
    __uuid: () => crypto.randomUUID(),
  };

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

function resolveParams(
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
