import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appClaim } from '@proappstore/build-core';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const migrations = new URL('../../../../migrations/', import.meta.url);
let db: InstanceType<typeof DatabaseSync>;
const routeInsert = (id: string, zone = 'proappstore.online') => `INSERT INTO routes (slug, zone, r2_prefix, store, created_at, updated_at) VALUES ('${id}', '${zone}', 'apps/${id}', 'pas', 1, 1)`;
const appInsert = (id: string) => `INSERT INTO apps (id, creator_id, created_at) VALUES ('${id}', 'gh:1', 1)`;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  for (const file of readdirSync(migrations).filter((name) => name.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(file, migrations), 'utf8'));
  db.exec(appInsert('original')); db.exec(appInsert('other'));
  db.exec(routeInsert('original')); db.exec(routeInsert('other'));
  db.exec("INSERT INTO app_custom_domains (app_id, domain, status, kind, canonical, added_at) VALUES ('original', 'renamed.proappstore.online', 'active', 'exact', 1, 1)");
});
afterEach(() => db.close());

describe('atomic canonical alias reservations (#574)', () => {
  it.each(['INSERT', 'INSERT OR IGNORE', 'INSERT OR REPLACE'])('refuses %s app and route claims of an active alias', (verb) => {
    expect(() => db.exec(appInsert('renamed').replace('INSERT', verb))).toThrow('reserved');
    expect(() => db.exec(routeInsert('renamed').replace('INSERT', verb))).toThrow('reserved');
    expect(db.prepare("SELECT id FROM apps WHERE id = 'renamed'").get()).toBeUndefined();
    expect(db.prepare("SELECT slug FROM routes WHERE slug = 'renamed'").get()).toBeUndefined();
  });
  it('refuses identity updates and route zone changes into the reserved namespace', () => {
    expect(() => db.exec("UPDATE apps SET id = 'renamed' WHERE id = 'other'")).toThrow('reserved');
    expect(() => db.exec("UPDATE routes SET slug = 'renamed' WHERE slug = 'other'")).toThrow('reserved');
    db.exec(routeInsert('renamed', 'example.com'));
    expect(() => db.exec("UPDATE routes SET zone = 'proappstore.online' WHERE slug = 'renamed'")).toThrow('reserved');
  });
  it('refuses assigning or activating canonical aliases over existing app identities and orphan routes', () => {
    db.exec(routeInsert('orphan'));
    for (const id of ['other', 'orphan']) {
      expect(() => db.exec(`INSERT INTO app_custom_domains (app_id, domain, status, canonical, added_at) VALUES ('original', '${id}.proappstore.online', 'active', 1, 1)`)).toThrow('reserved');
    }
    db.exec("INSERT INTO app_custom_domains (app_id, domain, status, canonical, added_at) VALUES ('other', 'original.proappstore.online', 'pending', 1, 1)");
    expect(() => db.exec("UPDATE app_custom_domains SET status = 'active' WHERE app_id = 'other'")).toThrow('reserved');
  });
  it('refuses active domain rebinding, renaming and noncanonical shadow rows', () => {
    expect(() => db.exec("UPDATE app_custom_domains SET app_id = 'other' WHERE app_id = 'original'")).toThrow('reserved');
    expect(() => db.exec("UPDATE app_custom_domains SET domain = 'other.proappstore.online' WHERE app_id = 'original'")).toThrow('reserved');
    expect(() => db.exec("INSERT INTO app_custom_domains (app_id, domain, status, canonical, added_at) VALUES ('other', 'renamed.proappstore.online', 'active', 0, 1)")).toThrow('reserved');
    db.exec("INSERT INTO app_custom_domains (app_id, domain, status, canonical, added_at) VALUES ('other', 'renamed.proappstore.online', 'pending', 0, 1)");
    expect(() => db.exec("UPDATE app_custom_domains SET status = 'active' WHERE app_id = 'other'")).toThrow('reserved');
  });
  it.each(['app', 'route'])('refuses migration completion when a pre-existing %s conflicts with an active alias', (kind) => {
    for (const trigger of ['canonical_alias_app_insert', 'canonical_alias_app_update', 'canonical_alias_route_insert', 'canonical_alias_route_update', 'canonical_alias_domain_insert', 'canonical_alias_domain_update']) db.exec(`DROP TRIGGER ${trigger}`);
    db.exec(kind === 'app' ? appInsert('renamed') : routeInsert('renamed'));
    expect(() => db.exec(readFileSync(new URL('0136_reserve_canonical_app_aliases.sql', migrations), 'utf8'))).toThrow('no_canonical_hostname_conflicts');
    // A136 failure does not pretend to undo the already-applied135/domain state.
    expect(db.prepare("SELECT app_id FROM app_custom_domains WHERE domain = 'renamed.proappstore.online'").get()).toEqual({ app_id: 'original' });
  });

  it('preserves ownership before the canonical-column migration and fails closed on other outages', async () => {
    const oldDb = new DatabaseSync(':memory:');
    try {
      for (const file of ['0002_apps.sql', '0009_app_custom_domains.sql']) oldDb.exec(readFileSync(new URL(file, migrations), 'utf8'));
      oldDb.exec(appInsert('original'));
      const d1 = { prepare: (sql: string) => ({ bind: (...args: unknown[]) => ({ first: async () => oldDb.prepare(sql).get(...args as never[]) ?? null }) }) } as unknown as D1Database;
      expect(await appClaim(d1, 'original')).toEqual({ creator_id: 'gh:1' });
      const unavailable = { prepare: () => { throw new Error('database unavailable'); } } as unknown as D1Database;
      await expect(appClaim(unavailable, 'original')).rejects.toThrow('database unavailable');
    } finally { oldDb.close(); }
  });

  it('keeps the original app identity re-provisionable and returns a reservation without leaking its owner', async () => {
    db.exec(appInsert('original').replace('INSERT', 'INSERT OR IGNORE'));
    db.exec(routeInsert('original').replace('INSERT', 'INSERT OR IGNORE'));
    const d1 = { prepare: (sql: string) => ({ bind: (...args: unknown[]) => ({ first: async () => db.prepare(sql).get(...args as never[]) ?? null }) }) } as unknown as D1Database;
    expect(await appClaim(d1, 'renamed')).toEqual({ creator_id: null, alias_reserved: 1 });
    expect(await appClaim(d1, 'original')).toEqual({ creator_id: 'gh:1', alias_reserved: 0 });
  });
});
