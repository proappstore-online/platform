import { describe, expect, it, vi } from 'vitest';
import { sqliteD1 } from '../sqlite-d1.js';
import { runScheduledActions } from './scheduled-actions.js';
import type { Env } from '../types.js';

// #597: the scheduler read every row of app_tools on each tick and filtered in JS.
// Its query must select the same actions as that filter did, from the partial index.
describe('runScheduledActions reads only scheduled actions (#597)', () => {
  it('selects exactly the rows the old full scan kept, through idx_app_tools_scheduled', async () => {
    const db = sqliteD1();
    const insert = db.prepare("INSERT INTO app_tools (app_id, name, manifest, created_at, updated_at) VALUES (?, ?, ?, 1, 1)");
    const tool = (extra: Record<string, unknown> = {}) => JSON.stringify({ description: 'x', operation: 'execute', sql: 'SELECT 1', params: {}, requires_auth: true, ...extra });
    for (let a = 0; a < 5; a += 1) {
      for (let i = 0; i < 200; i += 1) await insert.bind(`app${a}`, `plain_${i}`, tool()).run();
      await insert.bind(`app${a}`, 'nightly', tool({ schedule: { cron: '0 3 * * *', params: {} } })).run();
    }
    await insert.bind('app0', 'null_schedule', tool({ schedule: null })).run();
    await insert.bind('app0', 'broken', '{"schedule": {"cron": ').run(); // does not parse: skipped, and must not raise

    const prepare = vi.spyOn(db, 'prepare');
    // 12:02 UTC: no schedule above is due, so the tick reads and claims nothing else of interest.
    const report = await runScheduledActions({ env: { DB: db } as unknown as Env, now: Date.UTC(2026, 10, 22, 12, 2) });
    expect(report.due).toBe(0);

    const reads = prepare.mock.calls.map(([sql]) => sql).filter((sql) => sql.includes('FROM app_tools'));
    expect(reads).toHaveLength(1);
    const selected = db.sql.prepare(reads[0]!).all().map((r) => `${r.app_id}/${r.name}`).sort();
    // The old behaviour: every row, kept when its manifest parses and has a truthy schedule.
    const kept = db.sql.prepare('SELECT app_id, name, manifest FROM app_tools').all().filter((r) => {
      try { return Boolean((JSON.parse(String(r.manifest)) as { schedule?: unknown }).schedule); } catch { return false; }
    }).map((r) => `${r.app_id}/${r.name}`).sort();
    expect(selected).toEqual(kept);
    expect(selected).toEqual(['app0/nightly', 'app1/nightly', 'app2/nightly', 'app3/nightly', 'app4/nightly']);

    const plan = db.sql.prepare(`EXPLAIN QUERY PLAN ${reads[0]}`).all().map((r) => String(r.detail));
    expect(plan).toEqual(['SCAN app_tools USING INDEX idx_app_tools_scheduled']);
  });
});
