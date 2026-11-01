import { Hono } from 'hono';
import type { Env } from '../types.js';
import { HttpError, requireAppOwner, requireRecentAuth } from '../lib/auth.js';
import {
  chunkStatements,
  IMPORT_BATCH_SIZE,
  importStatements,
  readLiveSchema,
  validateImportTable,
  type ImportRow,
  type TableValidation,
} from '../lib/data-import.js';
import { forwardToDataWorker } from './actions.js';

/**
 * Owner bulk import (#515): load an existing dataset into one app's D1 when it
 * moves onto the platform — Firebase ports above all (see
 * skills/choose-proappstore-architecture/references/port-from-firebase.md).
 * Reuses the data worker's `/batch` endpoint over the trusted internal path,
 * the same one registered actions and the entitlement mirror use, rather than
 * adding a parallel write path. Owner session with a recent sign-in — the same
 * gate as the from-session worker deploy (#406, #440) — never a long-lived key.
 *
 * File upload is not duplicated here: `pas storage import` (the CLI) uploads
 * through the existing `PUT /v1/apps/:appId/storage/*` route file by file.
 */

export const dataImportRoutes = new Hono<{ Bindings: Env }>();

const MAX_IMPORT_TABLES = 50;

/** Body shape only — schema/column validation happens per table against the live D1. */
function parseTables(body: unknown): Record<string, ImportRow[]> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError('body must be an object', 400);
  const tables = (body as { tables?: unknown }).tables;
  if (!tables || typeof tables !== 'object' || Array.isArray(tables)) throw new HttpError('tables must be an object of table name -> row array', 400);
  const names = Object.keys(tables as Record<string, unknown>);
  if (names.length === 0) throw new HttpError('tables must name at least one table', 400);
  if (names.length > MAX_IMPORT_TABLES) throw new HttpError(`at most ${MAX_IMPORT_TABLES} tables per import call`, 400);
  const out: Record<string, ImportRow[]> = {};
  for (const name of names) {
    const rows = (tables as Record<string, unknown>)[name];
    if (!Array.isArray(rows)) throw new HttpError(`tables.${name} must be an array of rows`, 400);
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new HttpError(`tables.${name} has a row that is not an object`, 400);
    }
    out[name] = rows as ImportRow[];
  }
  return out;
}

/**
 * POST /apps/:appId/data/import  { dryRun?, tables: { [table]: row[] } }
 *
 * Every table is validated against the app's LIVE schema before anything is
 * written — a schema mismatch on any table refuses the whole call, dry-run or
 * not. `dryRun` reports row counts and stops there; otherwise every row is
 * written as an idempotent upsert, chunked into bounded `/batch` calls, and one
 * `app_logs` entry records the import.
 */
dataImportRoutes.post('/apps/:appId/data/import', async (c) => {
  const appId = c.req.param('appId')!;
  const user = await requireAppOwner(c, appId);
  requireRecentAuth(user, c.env);

  const body = await c.req.json().catch(() => null);
  const dryRun = (body as { dryRun?: unknown } | null)?.dryRun === true;
  const tables = parseTables(body);

  const validations: TableValidation[] = await Promise.all(
    Object.entries(tables).map(async ([table, rows]): Promise<TableValidation> => {
      let columns;
      try {
        columns = await readLiveSchema(c.env, appId, table);
      } catch {
        return { table, rows, pk: [], mismatches: [`could not read the live schema for "${table}"`] };
      }
      return validateImportTable(table, rows, columns);
    }),
  );

  const mismatches = validations.flatMap((v) => v.mismatches);
  if (mismatches.length) throw new HttpError('schema mismatch', 400, { mismatches });

  const summary = { dryRun, tables: Object.fromEntries(validations.map((v) => [v.table, { rows: v.rows.length }])) };
  if (dryRun) return c.json(summary);

  const statements = validations.flatMap((v) => importStatements(v));
  for (const chunk of chunkStatements(statements, IMPORT_BATCH_SIZE)) {
    const res = await forwardToDataWorker(c.env, appId, 'batch', { statements: chunk }, null);
    if (!res.ok) throw new HttpError('import write refused', 502);
  }

  const totalRows = validations.reduce((n, v) => n + v.rows.length, 0);
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO app_logs (app_id, user_id, client_id, ts, level, category, message, data, source, ingested_at)
     VALUES (?, ?, NULL, ?, 'info', 'import', ?, ?, 'server', ?)`,
  ).bind(
    appId,
    user.id,
    now,
    `owner bulk import: ${totalRows} row(s) across ${validations.length} table(s)`,
    JSON.stringify({ tables: summary.tables }),
    now,
  ).run();

  return c.json(summary);
});
