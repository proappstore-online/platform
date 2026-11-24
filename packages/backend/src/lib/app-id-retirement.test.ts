import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appClaim } from '@proappstore/build-core';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const migrations = new URL('../../../../migrations/', import.meta.url);
const files = readdirSync(migrations).filter((name) => name.endsWith('.sql')).sort();
const RETIREMENTS = '0152_app_id_retirements.sql';
let db: InstanceType<typeof DatabaseSync>;
const appInsert = (id: string) => `INSERT INTO apps (id, creator_id, created_at) VALUES ('${id}', 'gh:1', 1)`;
const routeInsert = (id: string, zone = 'proappstore.online') => `INSERT INTO routes (slug, zone, r2_prefix, store, created_at, updated_at) VALUES ('${id}', '${zone}', 'apps/${id}', 'pas', 1, 1)`;
const d1 = (sqlite: InstanceType<typeof DatabaseSync>) => ({
  prepare: (sql: string) => ({ bind: (...args: unknown[]) => ({ first: async () => sqlite.prepare(sql).get(...args as never[]) ?? null }) }),
}) as unknown as D1Database;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  for (const file of files) db.exec(readFileSync(new URL(file, migrations), 'utf8'));
  db.exec(appInsert('rideshare')); db.exec(routeInsert('rideshare'));
});
afterEach(() => db.close());

describe('retired app IDs (#686 Phase 1)', () => {
  it('retires loopride, the ID 0150 renamed to rideshare', () => {
    expect(db.prepare('SELECT old_id, new_id FROM app_id_retirements').all()).toEqual([{ old_id: 'loopride', new_id: 'rideshare' }]);
  });

  it.each(['INSERT', 'INSERT OR IGNORE', 'INSERT OR REPLACE'])('refuses %s of an app or platform route under a retired ID', (verb) => {
    expect(() => db.exec(appInsert('loopride').replace('INSERT', verb))).toThrow('app ID retired');
    expect(() => db.exec(routeInsert('loopride').replace('INSERT', verb))).toThrow('app ID retired');
    expect(db.prepare("SELECT 1 FROM apps WHERE id = 'loopride'").get()).toBeUndefined();
  });

  it('refuses renaming any other app or route onto a retired ID, including by a zone change', () => {
    db.exec(appInsert('other')); db.exec(routeInsert('other'));
    expect(() => db.exec("UPDATE apps SET id = 'loopride' WHERE id = 'other'")).toThrow('app ID retired');
    expect(() => db.exec("UPDATE routes SET slug = 'loopride' WHERE slug = 'other'")).toThrow('app ID retired');
    db.exec(routeInsert('loopride', 'example.com'));
    expect(() => db.exec("UPDATE routes SET zone = 'proappstore.online' WHERE slug = 'loopride'")).toThrow('app ID retired');
  });

  it('lets only the app it was retired to take the ID back (a rename rolled back)', () => {
    db.exec('PRAGMA defer_foreign_keys = ON');
    db.exec("UPDATE apps SET id = 'loopride' WHERE id = 'rideshare'");
    db.exec("UPDATE routes SET slug = 'loopride', r2_prefix = 'apps/loopride' WHERE slug = 'rideshare'");
    expect(db.prepare("SELECT id FROM apps WHERE id = 'loopride'").get()).toEqual({ id: 'loopride' });
  });

  it('fails the migration closed when the ID it retires is held by a live app or route', () => {
    for (const kind of ['app', 'route'] as const) {
      const fresh = new DatabaseSync(':memory:');
      try {
        for (const file of files.filter((name) => name < RETIREMENTS)) fresh.exec(readFileSync(new URL(file, migrations), 'utf8'));
        fresh.exec(kind === 'app' ? appInsert('loopride') : routeInsert('loopride'));
        expect(() => fresh.exec(readFileSync(new URL(RETIREMENTS, migrations), 'utf8'))).toThrow('no_live_retired_ids');
      } finally { fresh.close(); }
    }
  });

  it('appClaim reports a retired ID without an owner, and leaves live IDs as they were', async () => {
    expect(await appClaim(d1(db), 'loopride')).toEqual({ creator_id: null, alias_reserved: 0, retired: 1 });
    expect(await appClaim(d1(db), 'rideshare')).toEqual({ creator_id: 'gh:1', alias_reserved: 0, retired: 0 });
    expect(await appClaim(d1(db), 'brand-new')).toBeNull();
  });

  it('appClaim keeps the previous checks on a database that predates the retirements table', async () => {
    const old = new DatabaseSync(':memory:');
    try {
      for (const file of files.filter((name) => name < RETIREMENTS)) old.exec(readFileSync(new URL(file, migrations), 'utf8'));
      old.exec(appInsert('original'));
      old.exec("INSERT INTO app_custom_domains (app_id, domain, status, kind, canonical, added_at) VALUES ('original', 'renamed.proappstore.online', 'active', 'exact', 1, 1)");
      expect(await appClaim(d1(old), 'original')).toEqual({ creator_id: 'gh:1', alias_reserved: 0 });
      expect(await appClaim(d1(old), 'renamed')).toEqual({ creator_id: null, alias_reserved: 1 });
      expect(await appClaim(d1(old), 'loopride')).toBeNull();
    } finally { old.close(); }
  });
});
