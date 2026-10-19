import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { makeEnv, testToken } from '../test-helpers.js';
import { TRANSFER_TTL_MS } from './ownership.js';

// #423, against real SQLite (node:sqlite) running migration 0105 itself, so the
// guarded batches, the cascade and the append-only triggers are the real SQL.

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const MIGRATION = readFileSync(new URL('../../../../migrations/0105_app_ownership_transfers.sql', import.meta.url), 'utf8');

let sqlite: InstanceType<typeof DatabaseSync>;

type Stmt = { sql: string; args: unknown[] };
function exec({ sql, args }: Stmt, mode: 'first' | 'all' | 'run') {
  const st = sqlite.prepare(sql);
  const params = args.map((a) => (a === undefined ? null : a)) as never[];
  if (mode === 'first') return (st.get(...params) as unknown) ?? null;
  if (mode === 'all') return { results: st.all(...params) };
  const r = st.run(...params);
  return { meta: { changes: Number(r.changes) } };
}
const db = {
  prepare(sql: string) {
    const make = (args: unknown[]) => ({
      sql,
      args,
      bind: (...a: unknown[]) => make(a),
      first: async () => exec({ sql, args }, 'first'),
      all: async () => exec({ sql, args }, 'all'),
      run: async () => exec({ sql, args }, 'run'),
    });
    return make([]);
  },
  // D1 runs a batch as one transaction.
  async batch(stmts: Stmt[]) {
    sqlite.exec('BEGIN');
    try {
      const out = stmts.map((s) => (/^\s*(SELECT)/i.test(s.sql) ? exec(s, 'all') : exec(s, 'run')));
      sqlite.exec('COMMIT');
      return out;
    } catch (err) {
      sqlite.exec('ROLLBACK');
      throw err;
    }
  },
} as unknown as D1Database;

const OWNER = 'gh:1';
const RECIPIENT = 'gh:2';
const STRANGER = 'gh:3';
const ADMIN = 'gh:9';

function seed() {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE apps (id TEXT PRIMARY KEY, creator_id TEXT NOT NULL, d1_database_id TEXT, worker_name TEXT, pages_project TEXT,
      created_at INTEGER NOT NULL, template_id TEXT, template_rev TEXT);
    CREATE TABLE users (id TEXT PRIMARY KEY, provider TEXT NOT NULL, provider_id TEXT NOT NULL, login TEXT NOT NULL, email TEXT,
      avatar_url TEXT, created_at INTEGER NOT NULL, last_login_at INTEGER NOT NULL, is_child INTEGER NOT NULL DEFAULT 0, credential_email TEXT);
    CREATE TABLE team_members (app_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'viewer', invited_by TEXT,
      created_at INTEGER NOT NULL, PRIMARY KEY (app_id, user_id));
    CREATE TABLE app_custom_domains (app_id TEXT NOT NULL, domain TEXT NOT NULL, status TEXT, added_at INTEGER NOT NULL, PRIMARY KEY (app_id, domain));
    CREATE TABLE app_workers (app_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE licenses (key TEXT NOT NULL, app_id TEXT NOT NULL, user_id TEXT NOT NULL, issued_at INTEGER NOT NULL, expires_at INTEGER,
      revoked INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (app_id, key));
    CREATE TABLE oidc_session_grants (id TEXT PRIMARY KEY, repository TEXT NOT NULL, user_id TEXT NOT NULL, revoked_at INTEGER);
  `);
  sqlite.exec(MIGRATION);
  const user = sqlite.prepare('INSERT INTO users (id, provider, provider_id, login, email, created_at, last_login_at, is_child) VALUES (?, ?, ?, ?, ?, 0, 0, ?)');
  user.run(OWNER, 'github', '1', 'olivia', 'olivia@example.com', 0);
  user.run(RECIPIENT, 'github', '2', 'riley', 'riley@example.com', 0);
  user.run(STRANGER, 'google', '3', 'sam', 'sam@example.com', 0);
  user.run(ADMIN, 'github', '9', 'ada', 'ada@example.com', 0);
  user.run('cred:kid', 'credential', 'kid', 'rabbit-bear-wolf', null, 1);
  user.run('cred:adult', 'credential', 'adult', 'fox-owl-elk', 'shared@example.com', 0);
  user.run('google:dup', 'google', 'dup', 'dup1', 'dup@example.com', 0);
  user.run('gh:dup', 'github', 'dup', 'dup2', 'DUP@example.com', 0);
  sqlite.prepare("INSERT INTO apps (id, creator_id, d1_database_id, created_at) VALUES ('myapp', ?, 'd1-1', 1)").run(OWNER);
  sqlite.exec(`
    INSERT INTO team_members VALUES ('myapp', 'gh:5', 'owner', 'gh:1', 1);
    INSERT INTO app_custom_domains VALUES ('myapp', 'my.example.com', 'active', 1);
    INSERT INTO app_workers VALUES ('myapp', 1);
    INSERT INTO licenses VALUES ('k1', 'myapp', 'gh:7', 1, NULL, 0);
    INSERT INTO oidc_session_grants VALUES ('g1', 'proappstore-online/myapp', 'gh:1', NULL);
  `);
}

const tokens: Record<string, string> = {};
async function tok(uid: string) {
  tokens[uid] ??= await testToken(uid, { roles: uid === ADMIN ? ['user', 'admin'] : ['user'], login: uid });
  return tokens[uid]!;
}
let env: ReturnType<typeof makeEnv>;
async function call(uid: string | null, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (uid) headers.Authorization = `Bearer ${await tok(uid)}`;
  const res = await app.request(`/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, env);
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* plain-text error */ }
  return { status: res.status, json, text, headers: res.headers };
}
const owner = () => (sqlite.prepare("SELECT creator_id FROM apps WHERE id = 'myapp'").get() as { creator_id: string }).creator_id;
const transfers = () => sqlite.prepare('SELECT * FROM app_ownership_transfers ORDER BY id').all() as any[];
const audit = () => sqlite.prepare('SELECT action, actor FROM app_ownership_audit ORDER BY id').all() as any[];
const initiate = (to = 'riley') => call(OWNER, 'POST', '/apps/myapp/ownership/transfer', { to });

beforeEach(() => {
  seed();
  env = makeEnv({ DB: db });
});
afterEach(() => vi.restoreAllMocks());

describe('initiating a transfer', () => {
  it('only the creator can — not a team owner, not an admin, not a stranger', async () => {
    sqlite.exec("INSERT INTO users (id, provider, provider_id, login, created_at, last_login_at) VALUES ('gh:5', 'github', '5', 'teamowner', 0, 0)");
    for (const uid of ['gh:5', ADMIN, STRANGER]) {
      expect((await call(uid, 'POST', '/apps/myapp/ownership/transfer', { to: 'riley' })).status).toBe(403);
    }
    expect((await call(null, 'POST', '/apps/myapp/ownership/transfer', { to: 'riley' })).status).toBe(401);
    expect((await call(OWNER, 'POST', '/apps/nope/ownership/transfer', { to: 'riley' })).status).toBe(404);
    expect(transfers()).toHaveLength(0);
  });

  it.each([
    ['an unknown email', 'nobody@example.com'],
    ['a child account', 'cred:kid'],
    ['a username/password account', 'cred:adult'],
    ['an email shared by two accounts', 'dup@example.com'],
    ['an unknown GitHub login', 'ghost'],
  ])('refuses %s with one message and creates nothing', async (_label, to) => {
    const res = await initiate(to);
    expect(res.status).toBe(400);
    expect(res.text).toMatch(/not a verified PAS identity/);
    expect(transfers()).toHaveLength(0);
    expect(audit()).toHaveLength(0);
  });

  it('resolves a user id, an email or a GitHub login', async () => {
    for (const to of [RECIPIENT, 'Riley@Example.com', 'RILEY']) {
      const res = await call(OWNER, 'POST', '/apps/myapp/ownership/transfer', { to, dry_run: true });
      expect(res.status).toBe(200);
      expect(res.json.to).toEqual({ login: 'riley' });
    }
  });

  it('refuses a transfer to yourself', async () => {
    expect((await initiate('olivia')).status).toBe(400);
  });

  it('dry_run shows every implication and writes nothing', async () => {
    const res = await call(OWNER, 'POST', '/apps/myapp/ownership/transfer', { to: 'riley', dry_run: true });
    expect(res.status).toBe(200);
    const imp = res.json.implications;
    expect(imp.repository.full_name).toBe('proappstore-online/myapp');
    expect(imp.route).toMatchObject({ url: 'https://myapp.proappstore.online', custom_domains: ['my.example.com'] });
    expect(imp.data_worker).toMatchObject({ name: 'pas-data-myapp', database: 'provisioned' });
    expect(imp.app_worker).toEqual({ enabled: true });
    expect(imp.deploy.active_ci_session_grants).toBe(1);
    expect(imp.team.members).toBe(1);
    expect(imp.billing.active_licences).toBe(1);
    expect(transfers()).toHaveLength(0);
  });

  it('creates a pending, expiring transfer and audits it; the recipient sees only logins', async () => {
    const before = Date.now();
    const res = await initiate();
    expect(res.status).toBe(201);
    const [row] = transfers();
    expect(row).toMatchObject({ app_id: 'myapp', from_user: OWNER, to_user: RECIPIENT, kind: 'transfer', status: 'pending' });
    expect(row.expiry_ms).toBeGreaterThanOrEqual(before + TRANSFER_TTL_MS);
    expect(JSON.parse(row.implications_snapshot).repository.full_name).toBe('proappstore-online/myapp');
    expect(audit()).toEqual([{ action: 'initiated', actor: OWNER }]);
    expect(res.json.transfer).toMatchObject({ status: 'pending', from: { login: 'olivia' }, to: { login: 'riley' } });
    expect(JSON.stringify(res.json)).not.toMatch(/@example\.com|gh:\d/);
  });

  it('blocks a second pending transfer, but not once the first has expired', async () => {
    await initiate();
    expect((await initiate('sam@example.com')).status).toBe(409);
    sqlite.exec('UPDATE app_ownership_transfers SET expiry_ms = 1');
    expect((await initiate('sam@example.com')).status).toBe(201);
    expect(transfers().map((t) => t.status)).toEqual(['expired', 'pending']);
    expect(audit().map((a) => a.action)).toEqual(['initiated', 'expired', 'initiated']);
  });
});

describe('accepting', () => {
  it('moves ownership, records it, and leaves the old owner the audit trail', async () => {
    const { json } = await initiate();
    expect((await call(STRANGER, 'POST', `/apps/myapp/ownership/transfer/${json.transfer.id}/accept`)).status).toBe(403);
    expect((await call(OWNER, 'POST', `/apps/myapp/ownership/transfer/${json.transfer.id}/accept`)).status).toBe(403);
    const res = await call(RECIPIENT, 'POST', `/apps/myapp/ownership/transfer/${json.transfer.id}/accept`);
    expect(res.status).toBe(200);
    expect(res.json.transfer.status).toBe('accepted');
    expect(owner()).toBe(RECIPIENT);
    expect(audit()).toEqual([{ action: 'initiated', actor: OWNER }, { action: 'accepted', actor: RECIPIENT }]);

    const old = await call(OWNER, 'GET', '/apps/myapp/ownership');
    expect(old.json.you).toBe('sender');
    expect(old.json.owner).toBeNull();
    expect(old.json.audit.map((a: any) => [a.action, a.by])).toEqual([['initiated', 'you'], ['accepted', 'recipient']]);
    const now = await call(RECIPIENT, 'GET', '/apps/myapp/ownership');
    expect(now.json).toMatchObject({ you: 'owner', owner: { login: 'riley' } });
  });

  it('a replayed accept is refused and changes nothing', async () => {
    const { json } = await initiate();
    await call(RECIPIENT, 'POST', `/apps/myapp/ownership/transfer/${json.transfer.id}/accept`);
    // The app goes back to the original owner by a second, separate transfer…
    sqlite.prepare("UPDATE apps SET creator_id = ? WHERE id = 'myapp'").run(OWNER);
    // …and replaying the first accept must not hand it over again.
    expect((await call(RECIPIENT, 'POST', `/apps/myapp/ownership/transfer/${json.transfer.id}/accept`)).status).toBe(409);
    expect(owner()).toBe(OWNER);
    expect(audit().filter((a) => a.action === 'accepted')).toHaveLength(1);
  });

  it('an expired transfer cannot be accepted', async () => {
    const { json } = await initiate();
    sqlite.exec('UPDATE app_ownership_transfers SET expiry_ms = 1');
    expect((await call(RECIPIENT, 'POST', `/apps/myapp/ownership/transfer/${json.transfer.id}/accept`)).status).toBe(410);
    expect(owner()).toBe(OWNER);
    expect(transfers()[0].status).toBe('expired');
  });

  it('is refused when the sender no longer owns the app', async () => {
    const { json } = await initiate();
    sqlite.prepare("UPDATE apps SET creator_id = ? WHERE id = 'myapp'").run(STRANGER);
    expect((await call(RECIPIENT, 'POST', `/apps/myapp/ownership/transfer/${json.transfer.id}/accept`)).status).toBe(409);
    expect(owner()).toBe(STRANGER);
    expect(transfers()[0].status).toBe('pending');
  });

  it('closes every other open request for the app', async () => {
    await call(STRANGER, 'POST', '/apps/myapp/ownership/recovery', { evidence: 'I made it' });
    const { json } = await initiate();
    await call(RECIPIENT, 'POST', `/apps/myapp/ownership/transfer/${json.transfer.id}/accept`);
    expect(transfers().map((t) => [t.kind, t.status])).toEqual([['recovery', 'cancelled'], ['transfer', 'accepted']]);
    expect(audit().map((a) => a.action)).toContain('superseded');
  });
});

describe('declining, cancelling, escalating', () => {
  it('the recipient declines; the owner keeps the app', async () => {
    const { json } = await initiate();
    expect((await call(OWNER, 'POST', `/apps/myapp/ownership/transfer/${json.transfer.id}/decline`)).status).toBe(403);
    const res = await call(RECIPIENT, 'POST', `/apps/myapp/ownership/transfer/${json.transfer.id}/decline`);
    expect(res.status).toBe(200);
    expect(transfers()[0].status).toBe('declined');
    expect(owner()).toBe(OWNER);
    expect((await call(RECIPIENT, 'POST', `/apps/myapp/ownership/transfer/${json.transfer.id}/accept`)).status).toBe(409);
  });

  it('an expired transfer cannot be declined', async () => {
    const { json } = await initiate();
    sqlite.exec('UPDATE app_ownership_transfers SET expiry_ms = 1');
    expect((await call(RECIPIENT, 'POST', `/apps/myapp/ownership/transfer/${json.transfer.id}/decline`)).status).toBe(410);
  });

  it('only the sender cancels a transfer', async () => {
    const { json } = await initiate();
    expect((await call(RECIPIENT, 'POST', `/apps/myapp/ownership/transfer/${json.transfer.id}/cancel`)).status).toBe(403);
    expect((await call(OWNER, 'POST', `/apps/myapp/ownership/transfer/${json.transfer.id}/cancel`)).status).toBe(200);
    expect(transfers()[0].status).toBe('cancelled');
    expect((await call(OWNER, 'POST', `/apps/myapp/ownership/transfer/${json.transfer.id}/cancel`)).status).toBe(409);
  });

  it('either party escalates a pending transfer, even an expired one; nobody else can', async () => {
    const { json } = await initiate();
    sqlite.exec('UPDATE app_ownership_transfers SET expiry_ms = 1');
    expect((await call(STRANGER, 'POST', `/apps/myapp/ownership/transfer/${json.transfer.id}/escalate`)).status).toBe(403);
    const res = await call(RECIPIENT, 'POST', `/apps/myapp/ownership/transfer/${json.transfer.id}/escalate`, { reason: 'I lost the invited sign-in' });
    expect(res.status).toBe(200);
    expect(transfers()[0].status).toBe('escalated');
    expect((await call(RECIPIENT, 'POST', `/apps/myapp/ownership/transfer/${json.transfer.id}/accept`)).status).toBe(409);
    expect(owner()).toBe(OWNER);
  });

  it('rejects a malformed body and an unknown transfer', async () => {
    const { json } = await initiate();
    const res = await app.request(`/v1/apps/myapp/ownership/transfer/${json.transfer.id}/escalate`, {
      method: 'POST', headers: { Authorization: `Bearer ${await tok(RECIPIENT)}` }, body: '[1]',
    }, env);
    expect(res.status).toBe(400);
    expect((await call(RECIPIENT, 'POST', '/apps/myapp/ownership/transfer/999/accept')).status).toBe(404);
    expect((await call(RECIPIENT, 'POST', '/apps/myapp/ownership/transfer/abc/accept')).status).toBe(404);
  });
});

describe('recovery requests', () => {
  it('a non-owner files one; it waits for an admin and moves nothing', async () => {
    expect((await call(OWNER, 'POST', '/apps/myapp/ownership/recovery', { evidence: 'x' })).status).toBe(400);
    expect((await call(STRANGER, 'POST', '/apps/myapp/ownership/recovery', {})).status).toBe(400);
    const res = await call(STRANGER, 'POST', '/apps/myapp/ownership/recovery', { evidence: 'I created it as gh:3 before switching to Google' });
    expect(res.status).toBe(201);
    expect(transfers()[0]).toMatchObject({ kind: 'recovery', status: 'escalated', from_user: OWNER, to_user: STRANGER, expiry_ms: null });
    expect(owner()).toBe(OWNER);
    expect((await call(STRANGER, 'POST', '/apps/myapp/ownership/recovery', { evidence: 'again' })).status).toBe(409);
  });

  it('a credential account cannot file one', async () => {
    expect((await call('cred:adult', 'POST', '/apps/myapp/ownership/recovery', { evidence: 'mine' })).status).toBe(400);
  });

  it('neither side learns the other: the owner never sees who asked, the requester never sees the owner or the app internals', async () => {
    await call(STRANGER, 'POST', '/apps/myapp/ownership/recovery', { evidence: 'secret evidence' });
    const mine = await call(OWNER, 'GET', '/apps/myapp/ownership');
    expect(mine.json.you).toBe('owner');
    expect(mine.json.open[0]).toMatchObject({ kind: 'recovery', to: null });
    expect(mine.json.audit[0].detail).toEqual({ evidence: '[withheld]' });
    expect(JSON.stringify(mine.json)).not.toMatch(/sam|secret evidence/);

    const theirs = await call(STRANGER, 'GET', '/apps/myapp/ownership');
    expect(theirs.json.you).toBe('requester');
    expect(theirs.json.owner).toBeNull();
    expect(theirs.json.open[0]).toMatchObject({ from: null, implications: null });
    expect(JSON.stringify(theirs.json)).not.toMatch(/olivia|my\.example\.com/);
  });

  it('the requester can withdraw it; the owner cannot', async () => {
    const { json } = await call(STRANGER, 'POST', '/apps/myapp/ownership/recovery', { evidence: 'mine' });
    expect((await call(OWNER, 'POST', `/apps/myapp/ownership/transfer/${json.transfer.id}/cancel`)).status).toBe(403);
    expect((await call(STRANGER, 'POST', `/apps/myapp/ownership/transfer/${json.transfer.id}/cancel`)).status).toBe(200);
  });
});

describe('status for a non-party', () => {
  it('says only that the caller is not the owner, and is never cached', async () => {
    await initiate();
    const res = await call(STRANGER, 'GET', '/apps/myapp/ownership');
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ you: 'none', owner: null, can_request_recovery: true });
    expect(JSON.stringify(res.json)).not.toMatch(/olivia|riley|gh:\d/);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect((await call(null, 'GET', '/apps/myapp/ownership')).status).toBe(401);
    expect((await call(STRANGER, 'GET', '/apps/nope/ownership')).status).toBe(404);
  });
});

describe('admin resolution', () => {
  const resolve = (uid: string, id: number, body: unknown) => call(uid, 'POST', `/admin/apps/myapp/ownership/transfer/${id}/resolve`, body);

  it('approves a recovery with a recorded reason', async () => {
    const { json } = await call(STRANGER, 'POST', '/apps/myapp/ownership/recovery', { evidence: 'mine' });
    expect((await resolve(OWNER, json.transfer.id, { action: 'approve', reason: 'x' })).status).toBe(403);
    expect((await resolve(ADMIN, json.transfer.id, { action: 'approve' })).status).toBe(400);
    expect((await resolve(ADMIN, json.transfer.id, { action: 'maybe', reason: 'x' })).status).toBe(400);
    const res = await resolve(ADMIN, json.transfer.id, { action: 'approve', reason: 'Verified the original GitHub account by commit signature' });
    expect(res.status).toBe(200);
    expect(owner()).toBe(STRANGER);
    expect(transfers()[0]).toMatchObject({ status: 'admin_approved', admin_actor: ADMIN, admin_reason: 'Verified the original GitHub account by commit signature' });
    expect(audit().at(-1)).toEqual({ action: 'admin_approved', actor: ADMIN });
    expect(res.json.transfer.from.user_id).toBe(OWNER);
    // The previous owner can still read what happened and why.
    const old = await call(OWNER, 'GET', '/apps/myapp/ownership');
    expect(old.json.history[0]).toMatchObject({ status: 'admin_approved', resolution: { reason: 'Verified the original GitHub account by commit signature' } });
    expect(old.json.history[0].resolution.admin).toBeUndefined();
    expect(old.json.audit.at(-1).by).toBe('platform admin');
  });

  it('declines, leaving the owner in place', async () => {
    const { json } = await call(STRANGER, 'POST', '/apps/myapp/ownership/recovery', { evidence: 'mine' });
    expect((await resolve(ADMIN, json.transfer.id, { action: 'decline', reason: 'No evidence' })).status).toBe(200);
    expect(owner()).toBe(OWNER);
    expect(transfers()[0]).toMatchObject({ status: 'declined', admin_reason: 'No evidence' });
    expect(audit().at(-1)).toEqual({ action: 'admin_declined', actor: ADMIN });
  });

  it('resolves an escalated transfer', async () => {
    const { json } = await initiate();
    await call(OWNER, 'POST', `/apps/myapp/ownership/transfer/${json.transfer.id}/escalate`);
    expect((await resolve(ADMIN, json.transfer.id, { action: 'approve', reason: 'Both parties confirmed by email' })).status).toBe(200);
    expect(owner()).toBe(RECIPIENT);
  });

  it('only decides escalated rows, never to the admin, never against a changed owner', async () => {
    const { json } = await initiate();
    expect((await resolve(ADMIN, json.transfer.id, { action: 'approve', reason: 'x' })).status).toBe(409);

    const self = await call(ADMIN, 'POST', '/apps/myapp/ownership/recovery', { evidence: 'mine' });
    expect((await resolve(ADMIN, self.json.transfer.id, { action: 'approve', reason: 'x' })).status).toBe(403);

    const other = await call(STRANGER, 'POST', '/apps/myapp/ownership/recovery', { evidence: 'mine' });
    sqlite.prepare("UPDATE apps SET creator_id = ? WHERE id = 'myapp'").run(RECIPIENT);
    expect((await resolve(ADMIN, other.json.transfer.id, { action: 'approve', reason: 'x' })).status).toBe(409);
    expect(owner()).toBe(RECIPIENT);
  });
});

describe('the audit record', () => {
  it('is append-only and outlives the app', async () => {
    await initiate();
    expect(() => sqlite.exec("UPDATE app_ownership_audit SET action = 'forged'")).toThrow(/immutable/);
    expect(() => sqlite.exec('DELETE FROM app_ownership_audit')).toThrow(/immutable/);
    sqlite.exec("DELETE FROM apps WHERE id = 'myapp'");
    expect(transfers()).toHaveLength(0);
    expect(audit()).toHaveLength(1);
  });
});

describe('notifications', () => {
  it('emails each party at their own address, naming the other only by login', async () => {
    const sent: { to: string; text: string }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      sent.push(JSON.parse(String((init as RequestInit).body)));
      return new Response('{}', { status: 200 });
    });
    env = makeEnv({ DB: db, RESEND_API_KEY: 're_test' });
    const { json } = await initiate();
    await call(RECIPIENT, 'POST', `/apps/myapp/ownership/transfer/${json.transfer.id}/accept`);
    expect(sent.map((m) => m.to).sort()).toEqual(['olivia@example.com', 'olivia@example.com', 'riley@example.com', 'riley@example.com']);
    for (const m of sent) {
      const other = m.to === 'riley@example.com' ? 'olivia@example.com' : 'riley@example.com';
      expect(m.text).not.toContain(other);
    }
  });

  it('a failing mail provider never fails the transition', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    env = makeEnv({ DB: db, RESEND_API_KEY: 're_test' });
    expect((await initiate()).status).toBe(201);
  });
});
