import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { mintSession } from '@proappstore/build-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sqliteD1 } from '../sqlite-d1.js';
import { HttpError } from '../lib/auth.js';
import * as host from '../lib/app-worker-host.js';
import { appWorkerOwnerSelfServeOpen } from '../lib/app-worker-usage.js';
import { appWorkerRoutes } from './app-workers.js';
import type { Env } from '../types.js';

const KEY = 'owner-worker-unit-test-signing-key';
const api = new Hono<{ Bindings: Env }>();
api.onError((e, c) => c.json({ error: e.message }, (e instanceof HttpError ? e.status : 500) as 400));
api.route('/', appWorkerRoutes);
afterEach(() => vi.restoreAllMocks());

async function world() {
  const db = sqliteD1();
  const exec = (sql: string, ...p: unknown[]) => db.prepare(sql).bind(...p).run();
  const env = {
    DB: db, SESSION_SIGNING_KEY: KEY, ADMIN_GITHUB_IDS: 'gh:admin', APP_WORKER_BACKEND: 'loader',
    APP_WORKER_OWNER_SELF_SERVE: '1',
    STORAGE: { list: async () => ({ objects: [], truncated: false }), delete: async () => undefined },
  } as unknown as Env;
  const app = async (id: string) => {
    const cols = (await db.prepare('PRAGMA table_info(apps)').all<{ name: string; notnull: number; dflt_value: unknown }>()).results!
      .filter(c => c.notnull && c.dflt_value === null && !['id', 'creator_id'].includes(c.name)).map(c => c.name);
    await exec(`INSERT INTO apps (id,creator_id,${cols.join(',')}) VALUES (?, ?, ${cols.map(() => '?').join(',')})`,
      id, 'google:owner', ...cols.map(c => /_at$/.test(c) ? 1 : `${id}-${c}`));
  };
  await app('hiring');
  const call = async (uid: string | null, path: string, body: unknown = { enabled: true }, age = 0) => {
    const token = uid ? await mintSession({ uid, login: uid, roles: uid === 'gh:admin' ? ['admin'] : ['user'], auth_time: Math.floor(Date.now() / 1000) - age }, KEY) : null;
    return api.request(path, { method: 'PUT', headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }),
    }, body: body instanceof FormData ? body : JSON.stringify(body) }, env);
  };
  const enable = (uid: string | null = 'google:owner', enabled = true, id = 'hiring') =>
    call(uid, `/${uid === 'gh:admin' ? 'admin/' : ''}apps/${id}/worker-enabled`, { enabled });
  const row = () => db.prepare('SELECT enabled, enabled_at, admin_disabled_at FROM app_workers WHERE app_id = ?').bind('hiring').first();
  const deploy = () => {
    const body = new FormData();
    body.append('app.js', new Blob(['export default { async scheduled() {} };'], { type: 'application/javascript' }), 'app.js');
    return call('google:owner', '/apps/hiring/worker', body);
  };
  return { db, exec, env, app, call, enable, row, deploy };
}

describe('owner app-worker release (#267)', () => {
  it('still revokes a retained worker row after its app is removed', async () => {
    const w = await world();
    await w.exec("INSERT INTO app_workers(app_id,enabled) VALUES ('removed',1)");
    await host.disableAppWorker(w.env, 'removed');
    expect(await w.db.prepare("SELECT enabled, enabled_at FROM app_workers WHERE app_id='removed'").first())
      .toEqual({ enabled: 0, enabled_at: expect.any(Number) });
  });

  it('allows a Google owner and removes the prototype cap without granting another app access', async () => {
    const w = await world();
    for (let i = 0; i < 6; i++) await w.exec('INSERT INTO app_workers(app_id,enabled) VALUES (?,1)', `other${i}`);
    expect((await w.enable('google:stranger')).status).toBe(403);
    expect((await w.enable(null)).status).toBe(401);
    expect((await w.enable()).status).toBe(200);
    expect(await w.row()).toMatchObject({ enabled: 1, admin_disabled_at: null });
  });

  it('keeps the prototype fallback and recent-auth requirement', async () => {
    const w = await world();
    for (const flag of [undefined, '0', 'typo']) {
      w.env.APP_WORKER_OWNER_SELF_SERVE = flag;
      expect(appWorkerOwnerSelfServeOpen(w.env)).toBe(false);
      expect((await w.enable()).status).toBe(403);
    }
    w.env.APP_WORKER_OWNER_SELF_SERVE = 'true';
    expect((await w.call('google:owner', '/apps/hiring/worker-enabled', { enabled: true }, 900)).status).toBe(403);
    expect(await w.row()).toBeNull();
  });

  it('retains account closure and does not reset schedule breakers', async () => {
    const w = await world();
    await w.exec('UPDATE app_worker_platform SET open=0');
    expect((await w.enable()).status).toBe(409);
    await w.exec('UPDATE app_worker_platform SET open=1');
    await w.exec("INSERT INTO scheduled_action_state(app_id,action_name,source,consecutive_failures,schedule_disabled_at) VALUES ('hiring','worker:meeting_attendance','worker',5,123)");
    expect((await w.enable()).status).toBe(200);
    expect((await w.enable('google:owner', false)).status).toBe(200);
    expect((await w.enable()).status).toBe(200);
    expect(await w.db.prepare('SELECT consecutive_failures,schedule_disabled_at FROM scheduled_action_state').first())
      .toEqual({ consecutive_failures: 5, schedule_disabled_at: 123 });
  });

  it('persists an admin stop before any worker row exists; only an admin can clear it', async () => {
    const w = await world();
    expect((await w.enable('gh:admin', false, 'missing')).status).toBe(404);
    expect((await w.enable('gh:admin', false)).status).toBe(200);
    expect((await w.enable()).status).toBe(403);
    expect((await w.deploy()).status).toBe(403);
    expect((await w.enable('google:owner', false)).status).toBe(200);
    expect((await w.enable()).status).toBe(403);
    expect((await w.enable('gh:admin')).status).toBe(200);
    expect(await w.row()).toMatchObject({ enabled: 1, admin_disabled_at: null });
  });

  it.each(['admin', 'owner'])('does not let enablement overwrite a concurrent %s stop', async (actor) => {
    const w = await world();
    const prepare = w.db.prepare.bind(w.db);
    let intercepted = false;
    w.env.DB = { ...w.db, prepare: (sql: string) => {
      const statement = prepare(sql);
      if (!intercepted && sql.includes('INSERT INTO app_workers (app_id, enabled, enabled_by')) {
        intercepted = true;
        const bind = statement.bind.bind(statement);
        statement.bind = (...args: unknown[]) => {
          const bound = bind(...args);
          const run = bound.run.bind(bound);
          bound.run = async () => {
            await w.exec("INSERT INTO app_workers(app_id,enabled,enabled_at,admin_disabled_at) VALUES ('hiring',0,123,?)", actor === 'admin' ? 123 : null);
            return run();
          };
          return bound;
        };
      }
      return statement;
    } } as D1Database;
    expect((await (actor === 'admin' ? w.enable() : w.deploy())).status).toBe(actor === 'admin' ? 403 : 409);
    expect(await w.row()).toMatchObject({ enabled: 0, enabled_at: 123, admin_disabled_at: actor === 'admin' ? 123 : null });
  });

  it.each([false, true])('auto-enables a never-enabled existing app (worker row: %s) on verified owner deploy', async (existingRow) => {
    const w = await world();
    if (existingRow) await w.exec("INSERT INTO app_workers(app_id,enabled) VALUES ('hiring',0)");
    // The existing runtime suite covers the real loader. Here only the upload host
    // is substituted; actual session authorization, eligibility and SQL all run.
    const deploy = vi.fn(async () => ({ backend: 'loader', bundleSha256: 'abc', firstDeploy: true }));
    vi.spyOn(host, 'appWorkerHost').mockReturnValue({ backend: 'loader', deploy } as unknown as host.AppWorkerHost);
    const response = await w.deploy();
    expect(response.status, await response.text()).toBe(200);
    expect(deploy).toHaveBeenCalledOnce();
    expect(await w.row()).toMatchObject({ enabled: 1, admin_disabled_at: null });
  });

  it('does not auto-reenable an owner-disabled app, even when disabled before first deployment', async () => {
    const w = await world();
    expect((await w.enable('google:owner', false)).status).toBe(200);
    expect((await w.deploy()).status).toBe(403);
    expect((await w.enable()).status).toBe(200);
  });

  it('migrates ambiguous historical disables conservatively and leaves never-enabled apps eligible', async () => {
    const w = await world();
    w.db.sql.exec('ALTER TABLE app_workers DROP COLUMN admin_disabled_at; ALTER TABLE app_workers DROP COLUMN admin_disabled_by;');
    await w.exec("INSERT INTO app_workers(app_id,enabled,enabled_at) VALUES ('hiring',0,NULL),('stopped',0,123),('running',1,123)");
    w.db.sql.exec(readFileSync(new URL('../../../../migrations/0125_app_worker_admin_kill_switch.sql', import.meta.url), 'utf8'));
    expect((await w.db.prepare('SELECT app_id,admin_disabled_at FROM app_workers ORDER BY app_id').all()).results)
      .toEqual([{ app_id: 'hiring', admin_disabled_at: null }, { app_id: 'running', admin_disabled_at: null }, { app_id: 'stopped', admin_disabled_at: 123 }]);
  });
});
