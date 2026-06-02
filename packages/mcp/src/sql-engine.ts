/**
 * SQL engine for MCP tool execution. Handles:
 * - Named → positional parameter conversion
 * - Magic parameter injection (__user_id, __now, __uuid)
 * - Parameter validation (type, optional, default, max)
 */

interface ToolParam {
  type: string;
  description?: string;
  optional?: boolean;
  default?: unknown;
  max?: number;
}

export interface ToolManifest {
  name: string;
  description: string;
  operation: 'query' | 'execute';
  sql: string;
  params: Record<string, ToolParam>;
  requires_auth?: boolean;
}

interface PreparedQuery {
  sql: string;
  params: unknown[];
}

/**
 * Validate incoming params against the manifest schema and build
 * positional SQL with magic params injected.
 */
export function prepareQuery(
  manifest: ToolManifest,
  input: Record<string, unknown>,
  userId: string | null,
): PreparedQuery {
  const magicValues: Record<string, () => unknown> = {
    __user_id: () => {
      if (!userId) throw new Error('This tool requires authentication');
      return userId;
    },
    __now: () => Date.now(),
    __uuid: () => crypto.randomUUID(),
  };

  // Validate and resolve declared params
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

    // Type coercion/validation
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
        case 'string':
          value = String(value);
          break;
        case 'boolean':
          value = Boolean(value);
          break;
      }
    }

    resolved[name] = value;
  }

  // Find all :paramName references in SQL and replace with positional ?
  const paramNames: string[] = [];
  const positionalSql = manifest.sql.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_match, name: string) => {
    paramNames.push(name);
    return '?';
  });

  // Build positional params array
  const params = paramNames.map(name => {
    if (name in magicValues) return magicValues[name]();
    if (name in resolved) return resolved[name];
    throw new Error(`Unresolved parameter: ${name}`);
  });

  return { sql: positionalSql, params };
}
