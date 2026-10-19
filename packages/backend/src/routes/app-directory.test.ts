import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../index.js';
import { makeEnv, testToken } from '../test-helpers.js';
import { classifyLifecycle, exactIdFrom, isReservedId, type DirectorySignals } from './app-directory.js';

// #424, against real SQLite (node:sqlite) built from every root migration, so
// the directory's joins run on the production schema.

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const MIGRATIONS = new URL('../../../../migrations/', import.meta.url);

let sqlite: InstanceType<typeof DatabaseSync>;
const db = {
  prepare(sql: string) {
    const make = (args: unknown[]) => ({
      bind: (...a: unknown[]) => make(a),
      first: async () => (sqlite.prepare(sql).get(...(args as never[])) as unknown) ?? null,
      all: async () => ({ results: sqlite.prepare(sql).all(...(args as never[])) }),
      run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...(args as never[])).changes) } }),
    });
    return make([]);
  },
} as unknown as D1Database;

const ME = 'gh:1';
const OTHER = 'gh:2';
const NOW = Date.now();
const DAY = 86_400_000;

beforeAll(() => {
  sqlite = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL(f, MIGRATIONS), 'utf8'));
  }
  const appRow = sqlite.prepare('INSERT INTO apps (id, creator_id, created_at) VALUES (?, ?, ?)');
  const sub = sqlite.prepare(
    "INSERT INTO submissions (app_id, creator_id, status, name, category, description, created_at) VALUES (?, ?, ?, ?, 'tools', 'x', ?)",
  );
  const listed = sqlite.prepare('INSERT INTO app_storefront_publication (app_id, listed, updated_at) VALUES (?, ?, 1)');
  // Mine.
  appRow.run('alpha', ME, 1); sub.run('alpha', ME, 'published', 'Alpha Notes', 1); listed.run('alpha', 1);
  appRow.run('beta', ME, 2);
  sqlite.prepare("INSERT INTO deploy_audit (app_id, repository, ref, prefix, minted_at) VALUES ('beta', 'proappstore-online/beta', 'refs/heads/main', 'x', 500)").run();
  appRow.run('delta', ME, 3); listed.run('delta', 0);
  appRow.run('epsilon', ME, 4); sub.run('epsilon', ME, 'pending', 'Epsilon Ledger', 4);
  appRow.run('zeta', ME, 5);
  sqlite.prepare("INSERT INTO provision_operations (receipt_id, creator_id, app_id, status, created_at, updated_at) VALUES ('r1', ?, 'zeta', 'failed', 1, 1)").run(ME);
  appRow.run('eta', ME, 6);
  sqlite.prepare("INSERT INTO app_custom_domains (app_id, domain, added_at) VALUES ('eta', 'eta.example.com', 1)").run();
  appRow.run('handover', ME, 7);
  // A team app whose submission was filed by its creator, not by me: its name must still show.
  appRow.run('gamma', OTHER, 8); sub.run('gamma', OTHER, 'approved', 'Gamma Pro', 8);
  sqlite.prepare("INSERT INTO team_members (app_id, user_id, role, created_at) VALUES ('gamma', ?, 'developer', 1)").run(ME);
  // Operator (admin_access) access only.
  appRow.run('ops', OTHER, 9);
  sqlite.prepare("INSERT INTO app_operator_view (app_id, version, contract, created_at) VALUES ('ops', 1, ?, 1)")
    .run(JSON.stringify({ admin_access: { roles: ['support'] } }));
  sqlite.prepare("INSERT INTO app_roles (app_id, user_id, role_name) VALUES ('ops', ?, 'support')").run(ME);
  // Offered to me; and an expired offer that must not count.
  appRow.run('offer', OTHER, 10);
  appRow.run('stale', OTHER, 11);
  const transfer = sqlite.prepare(
    "INSERT INTO app_ownership_transfers (app_id, from_user, to_user, kind, status, expiry_ms) VALUES (?, ?, ?, 'transfer', 'pending', ?)",
  );
  transfer.run('offer', OTHER, ME, NOW + DAY);
  transfer.run('stale', OTHER, ME, NOW - DAY);
  transfer.run('handover', ME, OTHER, NOW + DAY);
  // Drafts.
  sqlite.prepare("INSERT INTO agent_projects (slug, owner_id, name, created_at) VALUES ('idea', ?, 'Big Idea', 12)").run(ME);
  sqlite.prepare("INSERT INTO provisioning_plans (plan_id, user_id, app_id, input_json, plan_json, created_at, expires_at) VALUES ('p1', ?, 'planned', '{}', '{}', 13, ?)").run(ME, NOW + DAY);
  sqlite.prepare("INSERT INTO provisioning_plans (plan_id, user_id, app_id, input_json, plan_json, created_at, expires_at) VALUES ('p2', ?, 'lapsed', '{}', '{}', 13, ?)").run(ME, NOW - DAY);
  // Not mine.
  appRow.run('theirs', OTHER, 14); sub.run('theirs', OTHER, 'published', 'Secret Name', 14); listed.run('theirs', 1);
  appRow.run('hidden', OTHER, 15);
  sqlite.prepare("INSERT INTO agent_projects (slug, owner_id, name, created_at) VALUES ('claimed', ?, 'Their Idea', 16)").run(OTHER);
});

let token: string;
async function dir(query = '', uid = ME) {
  token = await testToken(uid, { login: 'me' });
  const res = await app.request(`/v1/apps/directory${query ? `?${query}` : ''}`, { headers: { Authorization: `Bearer ${token}` } }, makeEnv({ DB: db }));
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* plain-text error */ }
  return { status: res.status, json, text, headers: res.headers };
}
const ids = (r: { json: any }) => r.json.items.map((i: any) => i.id).sort();
const item = (r: { json: any }, id: string) => r.json.items.find((i: any) => i.id === id);

describe('classifyLifecycle', () => {
  const base: DirectorySignals = { hasAppRow: true, provisionStatus: 'completed', lastDeployAt: null, submissionStatus: null, listed: null };
  it.each<[string, Partial<DirectorySignals>, string]>([
    ['no registry row', { hasAppRow: false }, 'draft'],
    ['failed provisioning beats everything else', { provisionStatus: 'failed', listed: 1 }, 'failed'],
    ['listed', { listed: 1, submissionStatus: 'published' }, 'live'],
    ['delisted, nothing in review', { listed: 0, submissionStatus: 'rejected' }, 'archived'],
    ['delisted, resubmitted', { listed: 0, submissionStatus: 'pending' }, 'unpublished'],
    ['submitted, never listed', { submissionStatus: 'approved' }, 'unpublished'],
    ['deployed, never submitted', { lastDeployAt: 1 }, 'deployed'],
    ['registered only', {}, 'provisioned'],
  ])('%s', (_label, signals, expected) => {
    expect(classifyLifecycle({ ...base, ...signals })).toBe(expected);
  });
});

describe('exactIdFrom', () => {
  it.each([
    ['chess', 'chess'],
    ['  Chess  ', 'chess'],
    ['https://chess.proappstore.online/', 'chess'],
    ['chess.proappstore.online/play?x=1', 'chess'],
    ['https://about-chess.proappstore.online', 'chess'],
    ['https://data-chess.proappstore.online/v1', 'chess'],
    ['https://proappstore.online/apps/chess/', 'chess'],
    ['github.com/proappstore-online/chess', 'chess'],
    ['https://github.com/proappstore-online/chess.git', 'chess'],
    ['https://github.com/proappstore-online/chess/actions', 'chess'],
  ])('%s → %s', (q, id) => expect(exactIdFrom(q)).toBe(id));

  it.each(['chess clubs', 'https://github.com/someone-else/chess', '9lives', ''])('%s names no single id', (q) => {
    expect(exactIdFrom(q)).toBeNull();
  });

  it('knows the platform hostnames and per-app prefixes', () => {
    expect(isReservedId('console')).toBe(true);
    expect(isReservedId('data-x')).toBe(true);
    expect(isReservedId('chess')).toBe(false);
  });
});

describe('GET /v1/apps/directory', () => {
  it('lists every app I can reach and my drafts — nothing else — never cached', async () => {
    const r = await dir();
    expect(r.status).toBe(200);
    expect(ids(r)).toEqual(['alpha', 'beta', 'delta', 'epsilon', 'eta', 'gamma', 'handover', 'idea', 'offer', 'ops', 'planned', 'zeta']);
    expect(r.json.lookup).toBeNull();
    expect(r.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('classifies each app and reports provisioning/deploy state', async () => {
    const r = await dir();
    const lifecycle = Object.fromEntries(r.json.items.map((i: any) => [i.id, i.lifecycle]));
    expect(lifecycle).toMatchObject({
      alpha: 'live', beta: 'deployed', delta: 'archived', epsilon: 'unpublished', zeta: 'failed', eta: 'provisioned',
      gamma: 'unpublished', idea: 'draft', planned: 'draft',
    });
    expect(item(r, 'beta')).toMatchObject({ deployStatus: 'deployed', lastDeployAt: 500 });
    expect(item(r, 'zeta').deployStatus).toBe('provision_failed');
    expect(item(r, 'idea').deployStatus).toBe('not_provisioned');
  });

  it('shows a team app by its real name, whoever filed the submission', async () => {
    const r = await dir();
    expect(item(r, 'gamma')).toMatchObject({ displayName: 'Gamma Pro', accessLevel: 'team', teamRole: 'developer', repoRef: 'proappstore-online/gamma' });
    expect(item(r, 'idea').displayName).toBe('Big Idea');
    expect(item(r, 'eta').displayName).toBe('Eta');
  });

  it('gives each access level only the links it can use', async () => {
    const r = await dir();
    expect(item(r, 'alpha')).toMatchObject({
      accessLevel: 'owner',
      routeUrl: 'https://alpha.proappstore.online',
      routeHealth: null,
      links: {
        details: 'https://console.proappstore.online/#/apps/alpha',
        deployHistory: 'https://github.com/proappstore-online/alpha/actions',
        ownership: '/v1/apps/alpha/ownership',
        storePage: 'https://proappstore.online/apps/alpha/',
        repository: 'https://github.com/proappstore-online/alpha',
      },
    });
    expect(item(r, 'beta').links.storePage).toBeNull();
    expect(item(r, 'ops')).toMatchObject({ accessLevel: 'operator', repoRef: null, links: { details: 'https://console.proappstore.online/#/apps/ops/operator', deployHistory: null, repository: null } });
    expect(item(r, 'offer')).toMatchObject({ accessLevel: 'transfer_recipient', pendingTransfer: 'incoming', repoRef: null, links: { details: null, ownership: '/v1/apps/offer/ownership' } });
    expect(item(r, 'handover').pendingTransfer).toBe('outgoing');
  });

  describe('search', () => {
    it.each([
      ['a display-name fragment', 'ledger', ['epsilon']],
      ['an id fragment', 'et', ['beta', 'eta', 'zeta']],
      ['the live URL', 'https://alpha.proappstore.online', ['alpha']],
      ['the store page', 'proappstore.online/apps/gamma', ['gamma']],
      ['the repository URL', 'https://github.com/proappstore-online/beta', ['beta']],
      ['a custom domain', 'https://eta.example.com/', ['eta']],
    ])('by %s', async (_label, q, expected) => {
      expect(ids(await dir(`q=${encodeURIComponent(q)}`))).toEqual(expected);
    });

    it('an id I own is "yours"; one I reach is "accessible"', async () => {
      expect((await dir('q=alpha')).json.lookup).toEqual({ id: 'alpha', status: 'yours' });
      expect((await dir(`q=${encodeURIComponent('https://github.com/proappstore-online/gamma')}`)).json.lookup).toEqual({ id: 'gamma', status: 'accessible' });
      expect((await dir(`q=${encodeURIComponent('https://about-alpha.proappstore.online')}`)).json.lookup).toEqual({ id: 'alpha', status: 'yours' });
    });

    it('an id someone else holds is exists_inaccessible, with only public facts and the recovery link', async () => {
      const r = await dir('q=theirs');
      expect(r.json.lookup).toEqual({ id: 'theirs', status: 'exists_inaccessible' });
      expect(r.json.items).toEqual([expect.objectContaining({
        id: 'theirs', displayName: 'theirs', accessLevel: 'inaccessible', lifecycle: 'live', repoRef: null,
        links: { details: null, deployHistory: null, ownership: '/v1/apps/theirs/ownership', storePage: 'https://proappstore.online/apps/theirs/', repository: null },
      })]);
      expect(r.text).not.toMatch(/Secret Name|gh:2/);
      const hidden = await dir('q=hidden');
      expect(item(hidden, 'hidden')).toMatchObject({ lifecycle: null, links: { storePage: null } });
      // An agent project alone claims the id.
      expect((await dir('q=claimed')).json.lookup.status).toBe('exists_inaccessible');
    });

    it('a free id is unclaimed; a platform hostname is reserved; neither is an app', async () => {
      const free = await dir('q=brand-new');
      expect(free.json).toMatchObject({ lookup: { id: 'brand-new', status: 'unclaimed' }, items: [] });
      const reserved = await dir(`q=${encodeURIComponent('https://console.proappstore.online')}`);
      expect(reserved.json).toMatchObject({ lookup: { id: 'console', status: 'reserved' }, items: [] });
      const lapsed = await dir('q=lapsed');
      expect(lapsed.json.lookup.status).toBe('unclaimed');
    });

    it('free text that names no id has no lookup', async () => {
      expect((await dir('q=notes%20app')).json.lookup).toBeNull();
      expect((await dir(`q=${encodeURIComponent('https://github.com/elsewhere/repo')}`)).json.lookup).toEqual({ id: 'https://github.com/elsewhere/repo', status: 'invalid' });
    });
  });

  describe('filters', () => {
    it('by lifecycle, one value or several', async () => {
      expect(ids(await dir('status=live'))).toEqual(['alpha']);
      expect(ids(await dir('status=archived,failed'))).toEqual(['delta', 'zeta']);
      expect(ids(await dir('status=draft'))).toEqual(['idea', 'planned']);
    });

    it('by access', async () => {
      expect(ids(await dir('access=team'))).toEqual(['gamma']);
      expect(ids(await dir('access=operator'))).toEqual(['ops']);
      expect(ids(await dir('access=transfer'))).toEqual(['handover', 'offer']);
      expect(ids(await dir('access=inaccessible'))).toEqual([]);
      expect(ids(await dir('access=inaccessible&q=theirs'))).toEqual(['theirs']);
      expect(ids(await dir('access=mine&status=unpublished'))).toEqual(['epsilon']);
    });

    it('limits, sorting the exact match first', async () => {
      const r = await dir('limit=2&q=et');
      expect(r.json).toMatchObject({ total: 3, truncated: true });
      expect(r.json.items).toHaveLength(2);
      expect((await dir('q=eta')).json.items[0].id).toBe('eta');
    });

    it.each(['status=down', 'access=everyone', 'limit=0', 'limit=500', 'limit=x', `q=${'a'.repeat(201)}`])('rejects %s', async (query) => {
      expect((await dir(query)).status).toBe(400);
    });
  });

  it('GET /v1/apps names a team app too (the same bug, fixed at its source)', async () => {
    const res = await app.request('/v1/apps', { headers: { Authorization: `Bearer ${await testToken(ME)}` } }, makeEnv({ DB: db }));
    const apps = ((await res.json()) as { apps: { id: string; name: string }[] }).apps;
    expect(apps.find((a) => a.id === 'gamma')?.name).toBe('Gamma Pro');
    expect(apps.find((a) => a.id === 'theirs')).toBeUndefined();
  });

  it('needs a session, and shows another user only their own apps', async () => {
    const res = await app.request('/v1/apps/directory', {}, makeEnv({ DB: db }));
    expect(res.status).toBe(401);
    expect(ids(await dir('', OTHER))).toEqual(['claimed', 'gamma', 'handover', 'hidden', 'offer', 'ops', 'stale', 'theirs']);
  });
});
