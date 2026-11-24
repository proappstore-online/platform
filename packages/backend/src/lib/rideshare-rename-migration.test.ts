import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { canonicalHostname, resolveRouteForHostname } from '../../../host/src/host.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

const migrations = new URL('../../../../migrations/', import.meta.url);
const rename = readFileSync(new URL('0150_rename_loopride_to_rideshare.sql', migrations), 'utf8');

function schema() {
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync(migrations).filter((name) => name.endsWith('.sql') && name < '0150_').sort()) {
    db.exec(readFileSync(new URL(file, migrations), 'utf8'));
  }
  return db;
}

function d1(db: InstanceType<typeof DatabaseSync>) {
  return { prepare: (sql: string) => ({ bind: (...args: unknown[]) => ({
    first: async () => db.prepare(sql).get(...args as never[]) ?? null,
  }) }) } as unknown as D1Database;
}

describe('loopride -> rideshare app-ID rename (#670)', () => {
  it('moves the app, its route, children and repo bindings, and keeps the old host as an alias', async () => {
    const db = schema();
    try {
      db.exec("INSERT INTO apps (id, creator_id, created_at, d1_database_id) VALUES ('loopride', 'gh:1', 1, 'd1-uuid')");
      db.exec("INSERT INTO apps (id, creator_id, created_at) VALUES ('other', 'gh:2', 1)");
      db.exec("INSERT INTO routes (slug, zone, r2_prefix, store, created_at, updated_at) VALUES ('loopride', 'proappstore.online', 'apps/loopride', 'pas', 1, 1)");
      // 0135's canonical host row, as it exists in production.
      db.exec("INSERT INTO app_custom_domains (app_id, domain, status, kind, added_at, canonical) VALUES ('loopride', 'rideshare.proappstore.online', 'active', 'exact', 1, 1)");
      db.exec("INSERT INTO app_visibility (app_id, mode, roles, created_at) VALUES ('loopride', 'public', '[]', 1)");
      db.exec("INSERT INTO app_roles (app_id, user_id, role_name, granted_by, granted_at) VALUES ('loopride', 'gh:1', 'owner', 'gh:1', 1)");
      db.exec("INSERT INTO app_roles (app_id, user_id, role_name, granted_by, granted_at) VALUES ('other', 'gh:2', 'owner', 'gh:2', 1)");
      db.exec("INSERT INTO project_repositories (app_id, full_name, source, status, created_at, updated_at) VALUES ('loopride', 'proappstore-online/loopride', 'convention', 'verified', 1, 1)");

      db.exec('PRAGMA foreign_keys = ON');
      db.exec('BEGIN');
      db.exec(rename);
      db.exec('COMMIT');
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

      expect(db.prepare('SELECT id, d1_database_id FROM apps ORDER BY id').all()).toEqual([{ id: 'other', d1_database_id: null }, { id: 'rideshare', d1_database_id: 'd1-uuid' }]);
      expect(db.prepare('SELECT slug, r2_prefix FROM routes').all()).toEqual([{ slug: 'rideshare', r2_prefix: 'apps/rideshare' }]);
      expect(db.prepare('SELECT app_id, user_id FROM app_roles ORDER BY app_id').all()).toEqual([{ app_id: 'other', user_id: 'gh:2' }, { app_id: 'rideshare', user_id: 'gh:1' }]);
      expect(db.prepare('SELECT app_id, full_name FROM project_repositories').get()).toEqual({ app_id: 'rideshare', full_name: 'proappstore-online/rideshare' });
      expect(db.prepare('SELECT app_id, domain, canonical FROM app_custom_domains ORDER BY domain').all()).toEqual([
        { app_id: 'rideshare', domain: 'loopride.proappstore.online', canonical: 0 },
        { app_id: 'rideshare', domain: 'rideshare.proappstore.online', canonical: 1 },
      ]);

      const route = d1(db);
      expect(await resolveRouteForHostname(route, 'rideshare.proappstore.online')).toMatchObject({ slug: 'rideshare', r2_prefix: 'apps/rideshare', matched: 'platform' });
      expect(await resolveRouteForHostname(route, 'loopride.proappstore.online')).toMatchObject({ slug: 'rideshare', matched: 'exact' });
      expect(await canonicalHostname(route, 'rideshare')).toBe('rideshare.proappstore.online');
    } finally {
      db.close();
    }
  });

  it('covers every table column that holds an app ID or repository', () => {
    const db = schema();
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%\\_new' ESCAPE '\\'").all() as { name: string }[];
      const missing: string[] = [];
      for (const { name } of tables) {
        const columns = (db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]).map((c) => c.name)
          .filter((c) => /^(app_id|project_slug|credential_app_id|repository|full_name)$/.test(c) || (c === 'slug' && ['routes', 'agent_projects'].includes(name)));
        for (const column of columns) if (!rename.includes(`UPDATE ${name} SET ${column} = `)) missing.push(`${name}.${column}`);
      }
      expect(missing).toEqual([]);
    } finally {
      db.close();
    }
  });
});
