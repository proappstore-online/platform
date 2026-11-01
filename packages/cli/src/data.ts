import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { Command } from 'commander';
import { ownerApi, requireSession, resolveAppIdOrExit } from './secret.js';

/**
 * `pas data import <dir>` (#515): owner bulk import of existing data (a
 * Firebase port above all) into one app's D1. One file per table —
 * `<table>.json` (a JSON array of row objects) or `<table>.jsonl` (one row
 * object per line) — posted to `POST /v1/apps/:appId/data/import`, which
 * validates every row's columns against the app's LIVE schema before writing
 * anything, and is safe to re-run (each row is an upsert keyed on the table's
 * own primary key). See skills/proappstore-data-migrations-actions/references
 * for the documented format.
 */

export type ImportRow = Record<string, unknown>;

function tableNameOf(file: string): string {
  return file.slice(0, file.length - extname(file).length);
}

/** One table's rows from `<table>.json` (a JSON array) or `<table>.jsonl` (one JSON object per line); blank lines are skipped. */
export async function readTableFile(path: string): Promise<ImportRow[]> {
  const raw = await readFile(path, 'utf8');
  if (path.endsWith('.jsonl')) {
    return raw.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line) as ImportRow);
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`${path}: a .json import file must be an array of row objects`);
  return parsed as ImportRow[];
}

/** Every `<table>.json` / `<table>.jsonl` in `dir`, keyed by table name. Refuses a table named by both extensions at once — ambiguous which wins. */
export async function readImportDir(dir: string): Promise<Record<string, ImportRow[]>> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json') || f.endsWith('.jsonl'));
  if (files.length === 0) throw new Error(`${dir}: no .json or .jsonl files found`);
  const byTable = new Map<string, string>();
  for (const file of files) {
    const table = tableNameOf(file);
    if (byTable.has(table)) throw new Error(`"${table}" has both a .json and a .jsonl file in ${dir} — keep one`);
    byTable.set(table, file);
  }
  const tables: Record<string, ImportRow[]> = {};
  for (const [table, file] of byTable) tables[table] = await readTableFile(join(dir, file));
  return tables;
}

interface ImportSummary {
  dryRun: boolean;
  tables: Record<string, { rows: number }>;
}

export async function importData(opts: { dir: string; app: string | undefined; dryRun?: boolean | undefined }): Promise<void> {
  const cfg = await requireSession();
  const appId = await resolveAppIdOrExit(opts.app);
  const tables = await readImportDir(opts.dir);
  const summary = await ownerApi<ImportSummary>(
    cfg, 'POST', `/v1/apps/${appId}/data/import`, 'import data',
    { dryRun: opts.dryRun === true, tables },
  );
  const verb = summary.dryRun ? 'would import' : 'imported';
  for (const [table, { rows }] of Object.entries(summary.tables)) {
    process.stdout.write(`${verb} ${rows} row(s) into "${table}"\n`);
  }
  if (summary.dryRun) process.stdout.write('dry run — nothing was written\n');
}

export const dataCommand = new Command('data')
  .description('Owner bulk import of existing data into an app\'s D1.')
  .addCommand(
    new Command('import')
      .description('Import <table>.json / <table>.jsonl files from a directory, one per table. Idempotent: safe to re-run.')
      .argument('<dir>', 'directory of <table>.json / <table>.jsonl files')
      .option('--app <id>', 'app id (defaults to package.json name in cwd)')
      .option('--dry-run', 'validate and report row counts; write nothing')
      .action((dir: string, opts: { app?: string; dryRun?: boolean }) => importData({ dir, app: opts.app, dryRun: opts.dryRun })),
  );
