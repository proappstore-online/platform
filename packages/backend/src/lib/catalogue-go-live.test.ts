import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sqliteD1 } from '../sqlite-d1.js';
import type { Env } from '../types.js';
import { goLiveListedApps } from './catalogue-go-live.js';

// #658: an app listed in the public catalogue goes live — its staged code actions are promoted
// and its go-live recorded — while an unlisted one stays staged.

let db: ReturnType<typeof sqliteD1>, env: Env;

const catalogueOf = (ids: string[]) => vi.fn(async () => Response.json({ apps: ids.map((id) => ({ id, appUrl: `https://${id}.proappstore.online` })) })) as unknown as typeof fetch;
const states = () => db.sql.prepare('SELECT app_id, name, source, state FROM app_tools ORDER BY app_id, name').all();
const goLive = () => db.sql.prepare('SELECT app_id, went_live_by FROM app_go_live ORDER BY app_id').all();

beforeEach(() => {
  db = sqliteD1();
  env = { DB: db } as unknown as Env;
  db.sql.exec(`
    INSERT INTO users (id, provider, provider_id, login, created_at, last_login_at) VALUES ('gh:1','github','1','owner',0,0);
    INSERT INTO apps (id, creator_id, created_at) VALUES ('run','gh:1',0), ('cv','gh:1',0), ('hr','gh:1',0), ('meet','gh:1',0);
    INSERT INTO app_go_live (app_id, went_live_at, went_live_by) VALUES ('meet', 1, 'migration-0109');
    INSERT INTO app_tools (app_id, name, manifest, created_at, updated_at, source, state) VALUES
      ('run','save_run','{}',0,0,'code','staged'), ('run','list_runs','{}',0,0,'code','staged'),
      ('run','api_export','{}',0,0,'console','staged'),
      ('cv','get_cv','{}',0,0,'code','staged'),
      ('hr','list_staff','{}',0,0,'code','staged'),
      ('meet','join','{}',0,0,'code','live'), ('meet','new_one','{}',0,0,'code','staged');
  `);
});

describe('goLiveListedApps (#658)', () => {
  it('promotes the staged code actions of listed apps and records their go-live; unlisted and already-live apps are untouched', async () => {
    const fetchImpl = catalogueOf(['run', 'cv', 'meet', 'not-an-app']);
    expect(await goLiveListedApps({ env, fetchImpl })).toEqual(['cv', 'run']);
    expect(states()).toEqual([
      { app_id: 'cv', name: 'get_cv', source: 'code', state: 'live' },
      { app_id: 'hr', name: 'list_staff', source: 'code', state: 'staged' },
      // meet already went live: a staged action it holds is its owner's to promote.
      { app_id: 'meet', name: 'join', source: 'code', state: 'live' },
      { app_id: 'meet', name: 'new_one', source: 'code', state: 'staged' },
      // Console endpoints are not code actions; the promote never touched them either.
      { app_id: 'run', name: 'api_export', source: 'console', state: 'staged' },
      { app_id: 'run', name: 'list_runs', source: 'code', state: 'live' },
      { app_id: 'run', name: 'save_run', source: 'code', state: 'live' },
    ]);
    expect(goLive()).toEqual([
      { app_id: 'cv', went_live_by: 'catalogue' },
      { app_id: 'meet', went_live_by: 'migration-0109' },
      { app_id: 'run', went_live_by: 'catalogue' },
    ]);
  });

  it('is idempotent: a later tick finds nothing to do and never demotes', async () => {
    const fetchImpl = catalogueOf(['run']);
    await goLiveListedApps({ env, fetchImpl });
    const before = { tools: states(), live: goLive() };
    // run is delisted: it stays live.
    expect(await goLiveListedApps({ env, fetchImpl: catalogueOf(['cv']) })).toEqual(['cv']);
    expect(await goLiveListedApps({ env, fetchImpl })).toEqual([]);
    expect(states().filter((r) => r.app_id === 'run')).toEqual(before.tools.filter((r) => r.app_id === 'run'));
    expect(goLive().filter((r) => r.app_id === 'run')).toEqual([{ app_id: 'run', went_live_by: 'catalogue' }]);
  });

  it.each([
    ['a failed fetch', vi.fn(async () => { throw new Error('network'); })],
    ['a 5xx', vi.fn(async () => new Response('down', { status: 503 }))],
    ['a body that is not JSON', vi.fn(async () => new Response('<html>'))],
    ['an empty catalogue', vi.fn(async () => Response.json({ apps: [] }))],
    ['a catalogue without apps', vi.fn(async () => Response.json({}))],
  ])('%s changes nothing', async (_, fetchImpl) => {
    const before = { tools: states(), live: goLive() };
    expect(await goLiveListedApps({ env, fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual([]);
    expect({ tools: states(), live: goLive() }).toEqual(before);
  });
});

describe('migration 0148 (#658)', () => {
  it('records go-live for run and cv and promotes their staged code actions, nothing else', () => {
    db.sql.exec(readFileSync(join(import.meta.dirname, '../../../../migrations/0148_catalogue_go_live.sql'), 'utf8'));
    expect(states().filter((r) => r.state === 'staged')).toEqual([
      { app_id: 'hr', name: 'list_staff', source: 'code', state: 'staged' },
      { app_id: 'meet', name: 'new_one', source: 'code', state: 'staged' },
      { app_id: 'run', name: 'api_export', source: 'console', state: 'staged' },
    ]);
    expect(goLive()).toEqual([
      { app_id: 'cv', went_live_by: 'migration-0148' },
      { app_id: 'meet', went_live_by: 'migration-0109' },
      { app_id: 'run', went_live_by: 'migration-0148' },
    ]);
  });
});
