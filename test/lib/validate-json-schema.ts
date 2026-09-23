/**
 * A deliberately small JSON Schema (2020-12) validator covering exactly the
 * subset the docs schemas use: type (string or array of strings), properties, required,
 * additionalProperties (boolean), items, enum, const, pattern, minLength,
 * minimum, minItems, uniqueItems, oneOf, $ref to #/$defs/*. No dependency, no
 * format/conditional keywords — keep the schemas inside this subset or extend
 * this file in the same commit.
 */
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Schema = { [k: string]: any };

export function validate(schema: Schema, value: Json, root: Schema = schema, path = '$'): string[] {
  const errors: string[] = [];
  if (schema.$ref) {
    const ref = String(schema.$ref);
    if (!ref.startsWith('#/')) return [`${path}: unsupported $ref ${ref}`];
    const target = ref.slice(2).split('/').reduce<any>((o, k) => (o ? o[k] : undefined), root);
    if (!target) return [`${path}: dangling $ref ${ref}`];
    return validate(target, value, root, path);
  }
  if (schema.oneOf) {
    const passing = (schema.oneOf as Schema[]).filter((s) => validate(s, value, root, path).length === 0).length;
    if (passing !== 1) errors.push(`${path}: matched ${passing} of oneOf, expected exactly 1`);
    return errors;
  }
  if (schema.const !== undefined && value !== schema.const) errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
  if (schema.enum && !(schema.enum as Json[]).some((e) => e === value)) errors.push(`${path}: ${JSON.stringify(value)} not in enum`);
  if (schema.type) {
    const t = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
    const matches = (want: string) => (want === 'integer' ? typeof value === 'number' && Number.isInteger(value) : t === want);
    const wanted: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!wanted.some(matches)) { errors.push(`${path}: expected ${wanted.join('|')}, got ${t}`); return errors; }
    // A nullable object/array: nothing below applies to null.
    if (value === null) return errors;
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: shorter than minLength ${schema.minLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: ${JSON.stringify(value)} does not match ${schema.pattern}`);
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below minimum ${schema.minimum}`);
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: fewer than minItems ${schema.minItems}`);
    if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) errors.push(`${path}: items not unique`);
    if (schema.items) value.forEach((v, i) => errors.push(...validate(schema.items, v, root, `${path}[${i}]`)));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as { [k: string]: Json };
    for (const r of (schema.required ?? []) as string[]) if (!(r in obj)) errors.push(`${path}: missing required ${r}`);
    const props = (schema.properties ?? {}) as Record<string, Schema>;
    for (const [k, v] of Object.entries(obj)) {
      if (props[k]) errors.push(...validate(props[k], v, root, `${path}.${k}`));
      else if (schema.additionalProperties === false) errors.push(`${path}: unexpected property ${k}`);
    }
  }
  return errors;
}
