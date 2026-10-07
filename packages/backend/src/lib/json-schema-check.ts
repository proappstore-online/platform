/**
 * A small JSON Schema checker for the keywords OPERATOR_VIEW_SCHEMA uses (#295,
 * #296): type, enum, not.enum, properties, required, additionalProperties,
 * items, minItems/maxItems, minLength/maxLength, pattern, minimum/maximum.
 * Returns every violation with its path, so a proposal's structural errors come
 * back together instead of one at a time. Structure only: the rules that need
 * the app's tools stay in validateOperatorView.
 */
type Schema = Record<string, unknown>;

export interface SchemaViolation { path: string; message: string }

export function schemaViolations(schema: Schema, value: unknown, path = 'operator_view'): SchemaViolation[] {
  const out: SchemaViolation[] = [];
  const add = (message: string) => out.push({ path, message });
  if (schema.enum && !(schema.enum as unknown[]).includes(value)) add(`must be one of ${(schema.enum as unknown[]).map((v) => JSON.stringify(v)).join(', ')}`);
  const never = (schema.not as Schema | undefined)?.enum as unknown[] | undefined;
  if (never?.includes(value)) add(`must not be ${JSON.stringify(value)}`);

  switch (schema.type) {
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) { add('must be an object'); break; }
      const props = (schema.properties ?? {}) as Record<string, Schema>;
      for (const r of (schema.required ?? []) as string[]) if (!(r in value)) out.push({ path: `${path}.${r}`, message: 'is required' });
      for (const [k, v] of Object.entries(value)) {
        const at = `${path}.${k}`;
        if (props[k]) out.push(...schemaViolations(props[k]!, v, at));
        else if (schema.additionalProperties === false) out.push({ path: at, message: 'is not a known field' });
        else if (typeof schema.additionalProperties === 'object') out.push(...schemaViolations(schema.additionalProperties as Schema, v, at));
      }
      break;
    }
    case 'array': {
      if (!Array.isArray(value)) { add('must be an array'); break; }
      if (typeof schema.minItems === 'number' && value.length < schema.minItems) add(`must have at least ${schema.minItems} item(s)`);
      if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) add(`must have at most ${schema.maxItems} items`);
      value.forEach((v, i) => out.push(...schemaViolations(schema.items as Schema, v, `${path}[${i}]`)));
      break;
    }
    case 'string': {
      if (typeof value !== 'string') { add('must be a string'); break; }
      if (typeof schema.minLength === 'number' && value.length < schema.minLength) add('must not be empty');
      if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) add(`must be at most ${schema.maxLength} characters`);
      if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) add(`must match ${schema.pattern}`);
      break;
    }
    case 'integer':
      if (!Number.isInteger(value)) add('must be an integer');
      else if ((value as number) < (schema.minimum as number) || (value as number) > (schema.maximum as number)) add(`must be from ${schema.minimum} to ${schema.maximum}`);
      break;
    case 'boolean':
      if (typeof value !== 'boolean') add('must be a boolean');
      break;
  }
  return out;
}
