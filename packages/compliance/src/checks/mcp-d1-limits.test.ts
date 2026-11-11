import { describe, expect, it } from 'vitest';
import { mapFileSource } from '../lib/file-source.js';
import { runChecksFromFiles } from '../index.js';
import { checkMcpD1Limits } from './mcp-d1-limits.js';

const union = (n: number) => Array.from({ length: n }, (_, i) => `SELECT ${i} AS x`).join(' UNION ALL ');
const run = (manifest?: unknown) => checkMcpD1Limits(mapFileSource(new Map(manifest === undefined ? [] : [['mcp.json', typeof manifest === 'string' ? manifest : JSON.stringify(manifest)]])));

describe('checkMcpD1Limits (#571)', () => {
  it('passes with no mcp.json, invalid JSON, or every statement within the limits', async () => {
    expect(await run()).toMatchObject({ status: 'pass', detail: 'no mcp.json' });
    expect((await run('{')).status).toBe('pass');
    expect(await run({ tools: [{ name: 'report', sql: union(5) }, { name: 'save', statements: ['INSERT INTO t VALUES (:a)'] }] }))
      .toMatchObject({ status: 'pass', detail: '2 action(s) within 100 parameters and 5 compound terms per statement' });
  });

  it('warns, never fails, naming each action over a limit', async () => {
    const binds101 = `SELECT ${Array.from({ length: 101 }, () => ':a').join(', ')}`;
    const result = await run({ tools: [{ name: 'report', sql: union(6) }, { name: 'save', statements: ['SELECT 1', binds101] }, 'junk'] });
    expect(result.status).toBe('warn');
    expect(result.detail).toMatch(/action "report" sql has a compound SELECT of 6 terms.*; action "save" statements\[1\] binds 101 parameters/);
    expect(result.suggestions?.join(' ')).toMatch(/Miniflare/);
  });

  it('runs in pas check, citing PAS-DATA-023', async () => {
    const results = await runChecksFromFiles(new Map([['mcp.json', JSON.stringify({ tools: [{ name: 'report', sql: union(6) }] })]]));
    const result = results.find((r) => r.checkId === 'mcp-d1-limits');
    expect(result).toMatchObject({ status: 'warn' });
    expect(result?.citations?.map((c) => c.clauseId)).toEqual(['PAS-DATA-023']);
  });
});
