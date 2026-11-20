/**
 * #606: a log-safe identity for the SQL an action sent, so an app owner can find the slow or oversized query.
 * Bound values are never read (they can be personal data); literals left in the SQL text are blanked too.
 */

import { sha256Hex } from './app-tokens.js';

const MAX_STATEMENTS = 5;
const MAX_SHAPE = 160;

function shapeOf(sql: string): string {
  return sql
    .replace(/--.*$/gm, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, '?')
    .replace(/\b\d+(?:\.\d+)?\b/g, '?')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export interface SqlFingerprint {
  /** First 12 hex of SHA-256 over the value-free shape: the same query always has the same id. */
  id: string;
  /** The value-free shape, truncated. */
  shape: string;
}

/** Fingerprints of the statements in a data-worker payload (`{sql}` or `{statements:[{sql}]}`); params are ignored. */
export async function sqlFingerprints(payload: unknown): Promise<SqlFingerprint[]> {
  const p = payload as { sql?: unknown; statements?: unknown } | null;
  const sqls: unknown[] = Array.isArray(p?.statements)
    ? (p.statements as { sql?: unknown }[]).map((s) => s?.sql)
    : [p?.sql];
  return Promise.all(
    sqls
      .filter((s): s is string => typeof s === 'string')
      .slice(0, MAX_STATEMENTS)
      .map(async (sql) => {
        const shape = shapeOf(sql);
        return { id: (await sha256Hex(shape)).slice(0, 12), shape: shape.slice(0, MAX_SHAPE) };
      }),
  );
}
