import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { mockNetwork, resetTables, seedApp, seedUser } from './helpers';

/**
 * Migration 0146 (#629, ADR-018) rebuilds native_grants to widen its capability CHECK. A plain rebuild's
 * DROP TABLE cascades into native_locations and erases every buffered point, so 0146 copies the points aside
 * and restores them. setup.ts has already applied every migration to empty tables; this re-runs 0146's
 * statements, as one batch like `wrangler d1 migrations apply`, against seeded grants and points on real D1.
 */
const MIGRATION = env.TEST_MIGRATIONS.find((m) => m.name.startsWith('0146_'));
const DB = env.DB;
const all = async (sql: string) => (await DB.prepare(sql).all()).results;
const grants = () => all('SELECT * FROM native_grants ORDER BY id');
const points = () => all('SELECT * FROM native_locations ORDER BY grant_id, point_id');

beforeEach(async () => {
  mockNetwork();
  await DB.prepare('DELETE FROM native_devices').run();
  await DB.prepare('DELETE FROM per_app_deleted_users').run();
  await resetTables();
  await seedUser('gh:1'); await seedUser('gh:2');
  await seedApp('run', 'gh:1'); await seedApp('ski', 'gh:1');
  const now = Date.now();
  await DB.batch([
    DB.prepare("INSERT INTO native_devices (id, user_id, label, token_hash, created_at, expires_at) VALUES ('d1', 'gh:1', 'Phone', 'hash-1', ?1, ?2)").bind(now, now + 60_000),
    DB.prepare(`INSERT INTO native_grants (id, device_id, app_id, publisher_id, capability, contract_version, consent_at) VALUES
      ('g-run', 'd1', 'run', 'gh:1', 'location.background', 'v-run', ?1),
      ('g-ski', 'd1', 'ski', 'gh:1', 'location.background', 'v-ski', ?1)`).bind(now),
    DB.prepare(`INSERT INTO native_locations (grant_id, point_id, recorded_at, latitude, longitude, accuracy) VALUES
      ('g-run', 'p1', ?1, -36.4, 148.4, 5), ('g-run', 'p2', ?2, -36.5, 148.5, 6), ('g-ski', 'p3', ?1, 1, 2, 3)`).bind(now, now + 1),
  ]);
});

const runMigration = () => DB.batch(MIGRATION!.queries.map((q) => DB.prepare(q)));

describe('migration 0146: native_grants rebuild for the capability registry', () => {
  it('exists and is the file deploy-backend.yml will apply', () => {
    expect(MIGRATION?.name).toBe('0146_native_capability_registry.sql');
  });

  it('keeps every grant and every point, with no foreign-key violation', async () => {
    const [beforeGrants, beforePoints] = [await grants(), await points()];
    expect(beforePoints).toHaveLength(3);
    await runMigration();
    expect(await grants()).toEqual(beforeGrants);
    expect(await points()).toEqual(beforePoints);
    expect(await all('PRAGMA foreign_key_check')).toEqual([]);
    expect(await all("SELECT name FROM sqlite_master WHERE name IN ('native_grants_new', 'native_locations_keep')")).toEqual([]);
    // Ran twice: harmless, nothing lost the second time either.
    await runMigration();
    expect(await points()).toEqual(beforePoints);
  });

  it('accepts any well-formed capability id and rejects a malformed one', async () => {
    await runMigration();
    await DB.prepare("INSERT INTO native_grants VALUES ('g-other', 'd1', 'run', 'gh:1', 'test.other', 'v-other', 0)").run();
    for (const bad of ['Bad.Id', 'heart-rate', 'x', 'a'.repeat(65), 'loc ation']) {
      await expect(DB.prepare("INSERT INTO native_grants VALUES ('g-bad', 'd1', 'ski', 'gh:1', ?, 'v', 0)").bind(bad).run(), bad).rejects.toThrow(/CHECK/);
    }
  });

  it('keeps the cascades and both revocation triggers working afterwards', async () => {
    await runMigration();
    // Publisher change: Run's grant and its points go; Ski's stay.
    await DB.prepare("UPDATE apps SET creator_id = 'gh:2' WHERE id = 'run'").run();
    expect((await grants()).map((g) => g.id)).toEqual(['g-ski']);
    expect((await points()).map((p) => p.point_id)).toEqual(['p3']);
    // Per-app account deletion.
    await DB.prepare("INSERT INTO per_app_deleted_users (app_id, user_id, deleted_by, deleted_at) VALUES ('ski', 'gh:1', 'gh:1', 0)").run();
    expect(await grants()).toEqual([]);
    expect(await points()).toEqual([]);
  });

  it('documents the hazard: without the keep copy, the rebuild on D1 erases every point through the cascade', async () => {
    const textbook = MIGRATION!.queries.filter((q) => !q.includes('native_locations_keep'));
    expect(textbook).toHaveLength(MIGRATION!.queries.length - 3);
    await DB.batch(textbook.map((q) => DB.prepare(q)));
    expect(await grants()).toHaveLength(2);
    expect(await points()).toEqual([]);
  });
});
