import { createExecutionContext, env as testEnv } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../../../backend/src/index';
import type { Env } from '../../../backend/src/types';
import { BASE, json, resetTables, seedUser, session } from './helpers';

const env = testEnv as unknown as Env;
const MIGRATION = testEnv.TEST_MIGRATIONS.find((m) => m.name.startsWith('0090_'));

// #363 (#303 N22) on real D1: one pending submission per app id, enforced by the
// partial unique index from migration 0090. The handler runs in-process on the
// real binding, so parallel submissions interleave at every await the way
// concurrent requests do.

const submit = async (uid: string, appId = 'kanban') => worker.fetch(
  new Request(`${BASE}/v1/submissions`, json('POST', { appId, name: 'Kanban', category: 'productivity', description: 'desc' }, await session(uid))),
  env,
  createExecutionContext(),
);
const pending = async (appId = 'kanban') =>
  (await env.DB.prepare("SELECT COUNT(*) AS n FROM submissions WHERE app_id = ? AND status = 'pending'").bind(appId).first<{ n: number }>())!.n;
const insertRaw = (id: string, status: string, createdAt: number, appId = 'kanban') =>
  env.DB.prepare("INSERT INTO submissions (id, app_id, creator_id, status, name, category, description, created_at) VALUES (?, ?, 'gh:a', ?, 'n', 'c', 'd', ?)")
    .bind(id, appId, status, createdAt).run();

beforeEach(async () => {
  await resetTables();
  await env.DB.prepare('DELETE FROM submissions').run();
  for (const uid of ['gh:a', 'gh:b', 'gh:c']) await seedUser(uid);
});

describe('one pending submission per app id (#363)', () => {
  it('three users racing one app id: exactly one 201, the rest 409, one pending row', async () => {
    const res = await Promise.all(['gh:a', 'gh:b', 'gh:c'].map((uid) => submit(uid)));
    expect(res.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(await pending()).toBe(1);
  });

  it('the index is partial and unique: a second pending row is refused, terminal rows are not', async () => {
    const idx = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_submissions_one_pending'").first<{ sql: string }>();
    expect(idx?.sql).toMatch(/UNIQUE INDEX .*\(app_id\) WHERE status = 'pending'/s);
    await insertRaw('p1', 'pending', 1);
    await expect(insertRaw('p2', 'pending', 2)).rejects.toThrow(/UNIQUE/);
    for (const [id, status] of [['r1', 'rejected'], ['r2', 'rejected'], ['a1', 'approved'], ['pub1', 'published']]) await insertRaw(id!, status!, 3);
    expect(await pending()).toBe(1);
  });

  it('resubmitting after a terminal state still works', async () => {
    for (const status of ['rejected', 'approved', 'published']) {
      await env.DB.prepare('DELETE FROM submissions').run();
      await insertRaw('old', status, 1);
      expect((await submit('gh:a')).status, status).toBe(201);
      expect(await pending()).toBe(1);
    }
    // And once the new one is rejected too, again.
    await env.DB.prepare("UPDATE submissions SET status = 'rejected' WHERE status = 'pending'").run();
    expect((await submit('gh:b')).status).toBe(201);
  });

  it('migration 0090 resolves existing duplicates by keeping the earliest pending row, then indexes', async () => {
    await env.DB.prepare('DROP INDEX idx_submissions_one_pending').run();
    await insertRaw('late', 'pending', 300);
    await insertRaw('first-b', 'pending', 100);
    await insertRaw('first-a', 'pending', 100);
    await insertRaw('other', 'pending', 200, 'notes');
    await insertRaw('done', 'rejected', 50);

    expect(MIGRATION?.name).toBe('0090_submissions_one_pending.sql');
    for (const q of MIGRATION!.queries) await env.DB.prepare(q).run();

    const rows = (await env.DB.prepare('SELECT id, status, rejection_reason FROM submissions ORDER BY id').all<{ id: string; status: string; rejection_reason: string | null }>()).results ?? [];
    expect(rows.map((r) => [r.id, r.status])).toEqual([
      ['done', 'rejected'], ['first-a', 'pending'], ['first-b', 'rejected'], ['late', 'rejected'], ['other', 'pending'],
    ]);
    expect(rows.find((r) => r.id === 'late')!.rejection_reason).toMatch(/Superseded/);
    expect(rows.find((r) => r.id === 'done')!.rejection_reason).toBeNull();
    await expect(insertRaw('again', 'pending', 400)).rejects.toThrow(/UNIQUE/);
  });
});
