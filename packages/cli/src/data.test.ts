import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #515: `pas data import <dir>` posts one table per <table>.json / <table>.jsonl
// file to the owner bulk-import route.

vi.mock('./lib/config.js', () => ({
  readConfig: async () => ({ apiBase: 'https://api.test', session: { token: 'tok' } }),
}));

const { importData, readImportDir, readTableFile } = await import('./data.js');

let dir: string;
let calls: { url: string; body: string }[];
let response: unknown;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pas-data-import-'));
  calls = [];
  response = { dryRun: false, tables: {} };
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, body: String(init.body ?? '') });
    return Response.json(response, { status: 200 });
  }));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('readTableFile', () => {
  it('reads a .json file as an array of rows', async () => {
    const file = join(dir, 'tasks.json');
    writeFileSync(file, JSON.stringify([{ id: '1' }, { id: '2' }]));
    expect(await readTableFile(file)).toEqual([{ id: '1' }, { id: '2' }]);
  });

  it('reads a .jsonl file, one row per line, skipping blank lines', async () => {
    const file = join(dir, 'tasks.jsonl');
    writeFileSync(file, '{"id":"1"}\n\n{"id":"2"}\n');
    expect(await readTableFile(file)).toEqual([{ id: '1' }, { id: '2' }]);
  });

  it('refuses a .json file that is not an array', async () => {
    const file = join(dir, 'tasks.json');
    writeFileSync(file, JSON.stringify({ id: '1' }));
    await expect(readTableFile(file)).rejects.toThrow('must be an array of row objects');
  });
});

describe('readImportDir', () => {
  it('reads every table file in the directory, keyed by table name', async () => {
    writeFileSync(join(dir, 'tasks.json'), JSON.stringify([{ id: '1' }]));
    writeFileSync(join(dir, 'users.jsonl'), '{"id":"u1"}\n');
    expect(await readImportDir(dir)).toEqual({ tasks: [{ id: '1' }], users: [{ id: 'u1' }] });
  });

  it('refuses an empty directory', async () => {
    await expect(readImportDir(dir)).rejects.toThrow('no .json or .jsonl files found');
  });

  it('refuses a table with both a .json and a .jsonl file', async () => {
    writeFileSync(join(dir, 'tasks.json'), '[]');
    writeFileSync(join(dir, 'tasks.jsonl'), '');
    await expect(readImportDir(dir)).rejects.toThrow('has both a .json and a .jsonl file');
  });
});

describe('importData', () => {
  it('posts { dryRun, tables } to the import route and prints a per-table summary', async () => {
    writeFileSync(join(dir, 'tasks.json'), JSON.stringify([{ id: '1', title: 'a' }]));
    response = { dryRun: false, tables: { tasks: { rows: 1 } } };
    await importData({ dir, app: 'test-app' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.test/v1/apps/test-app/data/import');
    expect(JSON.parse(calls[0]!.body)).toEqual({ dryRun: false, tables: { tasks: [{ id: '1', title: 'a' }] } });
    expect(process.stdout.write).toHaveBeenCalledWith('imported 1 row(s) into "tasks"\n');
  });

  it('a --dry-run sends dryRun: true and reports without claiming a write', async () => {
    writeFileSync(join(dir, 'tasks.json'), JSON.stringify([{ id: '1' }]));
    response = { dryRun: true, tables: { tasks: { rows: 1 } } };
    await importData({ dir, app: 'test-app', dryRun: true });
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ dryRun: true });
    expect(process.stdout.write).toHaveBeenCalledWith('would import 1 row(s) into "tasks"\n');
    expect(process.stdout.write).toHaveBeenCalledWith('dry run — nothing was written\n');
  });

  it('exits with the server error on a schema mismatch refusal', async () => {
    writeFileSync(join(dir, 'ghosts.json'), JSON.stringify([{ id: '1' }]));
    response = { error: 'schema mismatch', mismatches: ['table "ghosts" does not exist'] };
    vi.mocked(fetch).mockImplementationOnce(async () => Response.json(response, { status: 400 }));
    await expect(importData({ dir, app: 'test-app' })).rejects.toThrow('exit 1');
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining('schema mismatch'));
  });
});
