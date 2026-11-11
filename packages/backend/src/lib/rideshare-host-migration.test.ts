import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { resolveRouteForHostname } from '../../../host/src/host.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

const migrations = new URL('../../../../migrations/', import.meta.url);

describe('Rideshare public host migration (#573)', () => {
  it('retains the original identity and existing domains while declaring exactly one canonical host', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      for (const file of readdirSync(migrations).filter((name) => name.endsWith('.sql') && !name.startsWith('0135_')).sort()) {
        db.exec(readFileSync(new URL(file, migrations), 'utf8'));
      }
      db.exec("INSERT INTO apps (id, creator_id, created_at) VALUES ('loopride', 'gh:1', 1)");
      db.exec("INSERT INTO app_custom_domains (app_id, domain, status, added_at) VALUES ('loopride', 'existing.example', 'active', 1)");
      db.exec("INSERT INTO app_custom_domains (app_id, domain, status, added_at) VALUES ('loopride', 'rideshare.proappstore.online', 'pending', 1)");
      db.exec("INSERT INTO app_listings (app_id, tagline, long_description, updated_at) VALUES ('loopride', 'Loopride trips', 'RideShare and Loopride use https://loopride.proappstore.online', 1)");
      db.exec("INSERT INTO submissions (id, app_id, creator_id, status, name, category, description, created_at) VALUES ('original', 'loopride', 'gh:1', 'published', 'Loopride', 'transport', 'Original copy', 1)");
      db.exec(readFileSync(new URL('0135_rideshare_canonical_host.sql', migrations), 'utf8'));
      expect(db.prepare('SELECT id FROM apps').all()).toEqual([{ id: 'loopride' }]);
      expect(db.prepare('SELECT app_id, domain, canonical FROM app_custom_domains ORDER BY domain').all()).toEqual([
        { app_id: 'loopride', domain: 'existing.example', canonical: 0 },
        { app_id: 'loopride', domain: 'rideshare.proappstore.online', canonical: 1 },
      ]);
      expect(db.prepare('SELECT name, description, status FROM submissions').get()).toEqual({ name: 'Rideshare', description: 'Original copy', status: 'published' });
      expect(db.prepare('SELECT tagline, long_description FROM app_listings').get()).toEqual({ tagline: 'Rideshare trips', long_description: 'Rideshare and Rideshare use https://loopride.proappstore.online' });
      expect(() => db.exec("UPDATE app_custom_domains SET canonical = 1 WHERE domain = 'existing.example'")).toThrow();
      db.exec(readFileSync(new URL('../../../host/migrations/0001_create_routes.sql', import.meta.url), 'utf8'));
      db.exec("INSERT INTO routes (slug, zone, r2_prefix, store, created_at, updated_at) VALUES ('loopride', 'proappstore.online', 'apps/loopride', 'pas', 1, 1)");
      db.exec("INSERT INTO app_visibility (app_id, mode, created_at) VALUES ('loopride', 'private', 1)");
      const d1 = { prepare: (sql: string) => ({ bind: (...args: unknown[]) => ({
        first: async () => db.prepare(sql).get(...args as never[]) ?? null,
      }) }) } as unknown as D1Database;
      expect(await resolveRouteForHostname(d1, 'rideshare.proappstore.online')).toMatchObject({ slug: 'loopride', visibility_mode: 'private', r2_prefix: 'apps/loopride', matched: 'exact' });
      db.exec("INSERT INTO app_custom_domains (app_id, domain, status, kind, added_at) VALUES ('loopride', 'proappstore.online', 'active', 'wildcard', 1)");
      expect(await resolveRouteForHostname(d1, 'unregistered.proappstore.online')).toBeNull();

    } finally {
      db.close();
    }
  });
});
