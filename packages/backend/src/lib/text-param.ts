import { HttpError } from './auth.js';

/** An optional bounded text query parameter; empty means absent. A value over `max` chars is a 400 naming the parameter. */
export function textParam(value: string | undefined, max: number, name: string): string | null {
  const v = value?.trim() ?? '';
  if (!v) return null;
  if (v.length > max) throw new HttpError(`${name} is too long (max ${max} chars)`, 400);
  return v;
}
