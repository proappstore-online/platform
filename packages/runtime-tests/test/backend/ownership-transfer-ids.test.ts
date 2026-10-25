import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { BASE, json, mockNetwork, resetTables, seedApp, seedUser, session } from './helpers';

// #445 on real D1: transfer ids are never reused, so a deleted-and-re-created app's transfer
// always gets its own audit rows (the once-only audit guard cannot match a previous app's row).

const APP = 'reborn';

async function startAndCancel(): Promise<number> {
  const owner = await session('gh:1');
  const start = await SELF.fetch(`${BASE}/v1/apps/${APP}/ownership/transfer`, json('POST', { to: 'gh:2' }, owner));
  expect(start.status).toBe(201);
  const id = ((await start.json()) as { transfer: { id: number } }).transfer.id;
  const cancel = await SELF.fetch(`${BASE}/v1/apps/${APP}/ownership/transfer/${id}/cancel`, json('POST', {}, owner));
  expect(cancel.status).toBe(200);
  return id;
}
const audit = async (id: number) =>
  ((await env.DB.prepare('SELECT action FROM app_ownership_audit WHERE app_id = ? AND transfer_id = ? ORDER BY id').bind(APP, id).all<{ action: string }>()).results ?? []).map((r) => r.action);

beforeEach(async () => {
  mockNetwork();
  await resetTables();
  await seedUser('gh:1'); await seedUser('gh:2');
  await seedApp(APP, 'gh:1');
});

describe('ownership transfer ids (#445)', () => {
  it('a deleted app’s transfer id is not reused, and the re-created app’s transfer is fully audited', async () => {
    const first = await startAndCancel();
    expect(await audit(first)).toEqual(['initiated', 'cancelled']);

    // Delete the app: its transfer rows cascade away, the append-only audit stays.
    await env.DB.prepare('DELETE FROM apps WHERE id = ?').bind(APP).run();
    expect(await env.DB.prepare('SELECT 1 FROM app_ownership_transfers WHERE app_id = ?').bind(APP).first()).toBeNull();

    await seedApp(APP, 'gh:1');
    const second = await startAndCancel();
    expect(second).toBeGreaterThan(first);
    expect(await audit(second)).toEqual(['initiated', 'cancelled']); // its own rows, none skipped
    expect(await audit(first)).toEqual(['initiated', 'cancelled']); // the old history is untouched
  });

  it('migration 0115 keeps AUTOINCREMENT, preserves rows and starts above every id the audit recorded', async () => {
    const sql = (await env.DB.prepare("SELECT sql FROM sqlite_master WHERE name = 'app_ownership_transfers'").first<{ sql: string }>())!.sql;
    expect(sql).toContain('AUTOINCREMENT');
    const m = env.TEST_MIGRATIONS.find((x) => x.name.startsWith('0115_'))!;
    expect(m).toBeDefined();
    // Re-run the rebuild over a table holding a row and an audit-only id 40: ids 7 survives, 41 is next.
    await env.DB.prepare("INSERT INTO app_ownership_transfers (id, app_id, from_user, to_user, kind) VALUES (7, ?, 'gh:1', 'gh:2', 'transfer')").bind(APP).run();
    await env.DB.prepare("INSERT INTO app_ownership_audit (app_id, transfer_id, actor, action) VALUES ('gone', 40, 'gh:1', 'initiated')").run();
    for (const q of m.queries) await env.DB.prepare(q).run();
    expect((await env.DB.prepare('SELECT id FROM app_ownership_transfers').all<{ id: number }>()).results).toEqual([{ id: 7 }]);
    const next = await env.DB.prepare("INSERT INTO app_ownership_transfers (app_id, from_user, to_user, kind) VALUES (?, 'gh:1', 'gh:2', 'transfer') RETURNING id").bind(APP).first<{ id: number }>();
    expect(next!.id).toBeGreaterThan(40);
  });
});
