import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { bold, dim, green, red, yellow } from './lib/ansi.js';
import { splitSqlStatements } from './lib/sql-statements.js';

/**
 * `pas migrations test` (#503): before a deploy applies migrations.json to production, apply the whole chain to
 * a FRESH D1 and run every action once with schema-valid sample params.
 *
 * Why a real D1 engine: bookkeeper #62 shipped a migration whose triggers broke every workspace insert on D1 although
 * its tests passed on node:sqlite, and it ran in production on deploy. Miniflare runs workerd's own D1, the same
 * SQLite the platform uses, so what fails here fails there.
 *
 * What fails the run: any migration statement that errors (the data worker's /migrate refuses the same), and any
 * action whose SQL errors for a reason other than an expected constraint rejection (SQLITE_CONSTRAINT: a
 * foreign key, a unique index, a NOT NULL or a trigger's RAISE with sample values is the schema doing its job).
 * Rejections are reported, not failed: a trigger that rejects EVERY call looks the same, so read the list.
 */

export interface Migration { name: string; sql: string }
export interface ActionManifest {
  name: string;
  operation?: string;
  sql?: string;
  statements?: string[];
  params?: Record<string, { type?: string; optional?: boolean; default?: unknown; max?: number; enum?: unknown[] }>;
}

/** The slice of the D1 binding this uses, so tests can hand in any implementation. */
export interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): { run(): Promise<unknown>; all(): Promise<unknown> };
    run(): Promise<unknown>;
  };
  batch(statements: unknown[]): Promise<unknown>;
}

type ActionOutcome = 'ok' | 'rejected' | 'failed' | 'skipped';
interface ActionResult { name: string; operation: string; outcome: ActionOutcome; detail?: string }
interface MigrationFailure { migration: string; statementIndex: number; statement: string; detail: string }
export interface ChainReport {
  migrations: number;
  statements: number;
  migrationFailure: MigrationFailure | null;
  actions: ActionResult[];
  ok: boolean;
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 400);
/** A schema rejecting sample values: workerd names it SQLITE_CONSTRAINT, with or without an extended code. */
export const isConstraintRejection = (message: string): boolean => /\bSQLITE_CONSTRAINT/.test(message);

/** A value for a declared param: its default, else something of the right type that the executor's own typing accepts. */
export function sampleParam(schema: NonNullable<ActionManifest['params']>[string]): unknown {
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  switch (schema.type) {
    case 'integer':
    case 'number':
      return schema.max !== undefined ? Math.min(1, schema.max) : 1;
    case 'boolean':
      return true;
    default:
      return 'sample';
  }
}

/**
 * The executor's own binding (backend `bindStatement`): `:name` becomes `?` and the values follow in order, with the
 * three magic names resolved. Mirrored here; a parity test holds it equal to the backend's.
 */
export function bindAction(sql: string, resolved: Record<string, unknown>, userId = 'sample-user', now = Date.now()): { sql: string; params: unknown[] } {
  const names: string[] = [];
  const bound = sql.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_m, name: string) => {
    names.push(name);
    return '?';
  });
  const magic: Record<string, () => unknown> = { __user_id: () => userId, __now: () => now, __uuid: () => crypto.randomUUID() };
  const params = names.map((name) => {
    if (name in magic) return magic[name]!();
    if (name in resolved) return resolved[name];
    throw new Error(`Unresolved parameter: ${name}`);
  });
  return { sql: bound, params };
}

function actionStatements(a: ActionManifest): string[] {
  if (a.operation === 'batch') return Array.isArray(a.statements) ? a.statements : [];
  return typeof a.sql === 'string' ? [a.sql] : [];
}

/** Apply the chain, then run each action once. Never throws: every failure is in the report. */
export async function testMigrationChain(db: D1Like, input: { migrations: Migration[]; actions: ActionManifest[] }): Promise<ChainReport> {
  const report: ChainReport = { migrations: 0, statements: 0, migrationFailure: null, actions: [], ok: true };

  for (const m of input.migrations) {
    const statements = splitSqlStatements(m.sql);
    for (let i = 0; i < statements.length; i++) {
      try {
        await db.prepare(statements[i]!).run();
        report.statements++;
      } catch (e) {
        report.migrationFailure = { migration: m.name, statementIndex: i, statement: statements[i]!.slice(0, 300), detail: errorText(e) };
        report.ok = false;
        return report; // nothing after a broken migration means anything
      }
    }
    report.migrations++;
  }

  for (const a of input.actions) {
    const operation = a.operation ?? 'query';
    // A verify action runs platform code the app cannot supply; its SQL is exercised through the platform, not here.
    if (operation === 'verify') { report.actions.push({ name: a.name, operation, outcome: 'skipped', detail: 'verify actions run platform verifiers' }); continue; }
    const statements = actionStatements(a);
    if (statements.length === 0) { report.actions.push({ name: a.name, operation, outcome: 'skipped', detail: 'no sql' }); continue; }
    try {
      const resolved: Record<string, unknown> = {};
      for (const [name, schema] of Object.entries(a.params ?? {})) resolved[name] = sampleParam(schema ?? {});
      const now = Date.now();
      const prepared = statements.map((sql) => bindAction(sql, resolved, 'sample-user', now));
      if (operation === 'batch') {
        await db.batch(prepared.map((p) => db.prepare(p.sql).bind(...p.params)));
      } else if (operation === 'execute') {
        await db.prepare(prepared[0]!.sql).bind(...prepared[0]!.params).run();
      } else {
        await db.prepare(prepared[0]!.sql).bind(...prepared[0]!.params).all();
      }
      report.actions.push({ name: a.name, operation, outcome: 'ok' });
    } catch (e) {
      const detail = errorText(e);
      if (isConstraintRejection(detail)) report.actions.push({ name: a.name, operation, outcome: 'rejected', detail });
      else { report.actions.push({ name: a.name, operation, outcome: 'failed', detail }); report.ok = false; }
    }
  }
  return report;
}

type MiniflareModule = { Miniflare: new (opts: Record<string, unknown>) => { getD1Database(name: string): Promise<D1Like>; dispose(): Promise<void> } };

/** miniflare is not a dependency of this CLI (apps do not vendor it): `npx -p @proappstore/cli -p miniflare` puts it beside the CLI. */
const loadMiniflare = async (): Promise<MiniflareModule> => {
  const moduleName = 'miniflare';
  try {
    return (await import(moduleName)) as MiniflareModule;
  } catch {
    throw new MiniflareUnavailable("miniflare is not installed. Run through npx so it comes with the command: `npx -p @proappstore/cli@latest -p miniflare pas migrations test`.");
  }
};

/** A fresh in-memory D1 on workerd's own engine, via miniflare. `load` is for tests, which resolve miniflare from their own package. */
export async function withFreshD1<T>(run: (db: D1Like) => Promise<T>, load: () => Promise<MiniflareModule> = loadMiniflare): Promise<T> {
  const { Miniflare } = await load();
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2024-12-01',
    d1Databases: { DB: 'migration-chain-test' },
  });
  try {
    return await run(await mf.getD1Database('DB'));
  } finally {
    await mf.dispose().catch(() => undefined);
  }
}

export class MiniflareUnavailable extends Error {}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export const migrationsCommand = new Command('migrations').description('Migration tooling');

migrationsCommand
  .command('test')
  .description("Apply migrations.json to a fresh D1 and run every action in mcp.json once, before production does (#503)")
  .option('--dir <path>', 'App root', '.')
  .option('--json', 'Print the report as JSON')
  .action(async (opts: { dir: string; json?: boolean }) => {
    const root = resolve(opts.dir);
    const manifest = readJson<{ migrations?: Migration[] }>(resolve(root, 'migrations.json'));
    const migrations = Array.isArray(manifest?.migrations) ? manifest.migrations : [];
    const actions = readJson<{ tools?: ActionManifest[] }>(resolve(root, 'mcp.json'))?.tools ?? [];
    if (migrations.length === 0) {
      process.stdout.write(`${dim('No migrations.json: nothing to test.')}\n`);
      return;
    }
    let report: ChainReport;
    try {
      report = await withFreshD1((db) => testMigrationChain(db, { migrations, actions }));
    } catch (e) {
      // 2: the check itself could not run (no miniflare, workerd would not start). Distinct from a failing app (1).
      process.stderr.write(`${red('Could not start a D1 to test against:')} ${errorText(e)}\n`);
      process.exit(2);
    }
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(report)}\n`);
    } else {
      process.stdout.write(`${bold('Migration chain')}  ${report.migrations}/${migrations.length} migration(s), ${report.statements} statement(s) on a fresh D1\n`);
      if (report.migrationFailure) {
        const f = report.migrationFailure;
        process.stdout.write(`${red('✗')} migration ${f.migration}, statement ${f.statementIndex}: ${f.detail}\n    ${dim(f.statement)}\n`);
      }
      for (const a of report.actions) {
        const mark = a.outcome === 'ok' ? green('✓') : a.outcome === 'failed' ? red('✗') : yellow(a.outcome === 'rejected' ? '!' : '-');
        process.stdout.write(`${mark} ${a.name.padEnd(32)} ${dim(a.outcome + (a.detail ? `: ${a.detail}` : ''))}\n`);
      }
      const rejected = report.actions.filter((a) => a.outcome === 'rejected').length;
      if (rejected > 0) process.stdout.write(`${yellow('!')} ${rejected} action(s) were rejected by a constraint with sample values: expected for a foreign key or unique index, but a trigger that rejects every call looks the same.\n`);
    }
    process.exit(report.ok ? 0 : 1);
  });
