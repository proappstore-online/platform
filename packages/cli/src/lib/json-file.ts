import { existsSync, readFileSync } from 'node:fs';

/** Parse a JSON file, or null when it is missing or not valid JSON. */
export function readJsonIfExists<T = unknown>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}
