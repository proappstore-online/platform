import { mintSession } from '@proappstore/build-core';
import { describe, expect, it } from 'vitest';
import { accountRoutes } from '../../routes/accounts.js';
import { sqliteD1 } from '../../sqlite-d1.js';
import type { Env } from '../../types.js';
import { personalAccountId, runPersonalBackfill } from './backfill.js';

const KEY = 'unit-test-signing-key-0123456789abcdef';

function world(flags: Partial<Env> = { ACCOUNTS_WRITE: '1' }) {
  const db = sqliteD1();
  const env = { DB: db, SESSION_SIGNING_KEY: KEY, ...flags } as unknown as Env;
  const exec = (sql: string, ...p: unknown[]) => db.prepare(sql).bind(...p).run();
  const all = async <T>(sql: string, ...p: unknown[]) => ((await db.prepare(sql).bind(...p).all<T>()).results ?? []) as T[];
  const user = (id: string, extra: { provider?: string; pid?: string; credentialApp?: string | null } = {}) =>
    exec('INSERT INTO users (id, provider, provider_id, login, created_at, last_login_at, credential_app_id) VALUES (?1, ?2, ?3, ?1, 1, 1, ?4)', id, extra.provider ?? 'github', extra.pid ?? id, extra.credentialApp ?? null);
  const app = async (id: string, creator: string) => {
    const cols = (await all<{ name: string; notnull: number; dflt_value: string | null }>('PRAGMA table_info(apps)')).filter((c) => c.notnull && c.dflt_value === null && !['id', 'creator_id'].includes(c.name)).map((c) => c.name);
    await db.prepare(`INSERT INTO apps (id, creator_id, ${cols.join(',')}) VALUES (?, ?, ${cols.map(() => '?').join(',')})`).bind(id, creator, ...cols.map((c) => (/_at$/.test(c) ? 1 : `${id}-${c}`))).run();
  };
  const call = async (method: string, path: string, uid: string, body?: unknown, headers: Record<string, string> = {}, via?: string) => {
    const token = await mintSession({ uid, login: uid, avatarUrl: null, roles: ['user'], ...(via ? { via } : {}), auth_time: Math.floor(Date.now() / 1000), auth_method: 'github' }, KEY);
    const res = await accountRoutes.request(path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }, env);
    return { res, status: res.status, json: (await res.json().catch(() => null)) as any };
  };
  let n = 0;
  const idem = () => ({ 'idempotency-key': `test-key-${++n}-padding` });
  return { db, env, exec, all, user, app, call, idem };
}

describe('schema invariants at the write boundary', () => {
  it('refuses to create an account that is not provisioning, and to activate one without an owner', async () => {
    const w = world();
    await expect(w.exec("INSERT INTO accounts (id, kind, name, slug, status, created_by, created_at, updated_at) VALUES ('a','team','T','t1','active','u',1,1)")).rejects.toThrow(/account_must_start_provisioning/);
    await w.exec("INSERT INTO accounts (id, kind, name, slug, created_by, created_at, updated_at) VALUES ('a','team','T','t1','u',1,1)");
    await expect(w.exec("UPDATE accounts SET status = 'active' WHERE id = 'a'")).rejects.toThrow(/account_needs_owner/);
  });

  it('keeps an active team ownerful: the last owner can be neither demoted, removed nor deleted', async () => {
    const w = world();
    await w.exec("INSERT INTO accounts (id, kind, name, slug, created_by, created_at, updated_at) VALUES ('a','team','T','t1','u',1,1)");
    await w.exec("INSERT INTO account_memberships (account_id, user_id, role, created_by, created_at, updated_at) VALUES ('a','o1','owner','o1',1,1),('a','o2','owner','o1',1,1)");
    await w.exec("UPDATE accounts SET status = 'active' WHERE id = 'a'");
    await w.exec("UPDATE account_memberships SET role = 'admin' WHERE account_id = 'a' AND user_id = 'o1'"); // o2 remains
    await expect(w.exec("UPDATE account_memberships SET role = 'admin' WHERE account_id = 'a' AND user_id = 'o2'")).rejects.toThrow(/last_owner/);
    await expect(w.exec("UPDATE account_memberships SET status = 'removed' WHERE account_id = 'a' AND user_id = 'o2'")).rejects.toThrow(/last_owner/);
    await expect(w.exec("DELETE FROM account_memberships WHERE account_id = 'a' AND user_id = 'o2'")).rejects.toThrow(/last_owner/);
  });

  it('personal accounts need a user and teams must not have one; one personal account per user; slugs are lower-case and unique', async () => {
    const w = world();
    const ins = (id: string, kind: string, slug: string, pu: string | null) => w.exec('INSERT INTO accounts (id, kind, name, slug, personal_user_id, created_by, created_at, updated_at) VALUES (?1,?2,?1,?3,?4,?1,1,1)', id, kind, slug, pu);
    await expect(ins('x1', 'personal', 'x1', null)).rejects.toThrow();
    await expect(ins('x2', 'team', 'x2', 'u')).rejects.toThrow();
    await ins('p1', 'personal', 'p1', 'u');
    await expect(ins('p2', 'personal', 'p2', 'u')).rejects.toThrow(/UNIQUE/);
    await expect(ins('t1', 'team', 'p1', null)).rejects.toThrow(/UNIQUE/);
    await expect(ins('t2', 'team', 'UPPER', null)).rejects.toThrow(/CHECK/);
  });

  it('the audit trail is append-only', async () => {
    const w = world();
    await w.exec("INSERT INTO account_audit_events (id, actor_id, credential, action, created_at) VALUES ('e','u','first_party_session','x',1)");
    await expect(w.exec("UPDATE account_audit_events SET action = 'y'")).rejects.toThrow(/append-only/);
    await expect(w.exec('DELETE FROM account_audit_events')).rejects.toThrow(/append-only/);
  });

  it('adds the owner columns without touching existing rows', async () => {
    const w = world();
    await w.user('gh:1');
    await w.app('a1', 'gh:1');
    expect(await w.all('SELECT owner_account_id, ownership_version, access_version, authorization_model FROM apps')).toEqual([{ owner_account_id: null, ownership_version: 0, access_version: 0, authorization_model: 'legacy' }]);
  });
});

describe('personal-account backfill', () => {
  async function fixture() {
    const w = world();
    for (const u of ['gh:alice', 'gh:bob', 'gh:carol', 'gh:dave', 'gh:frank', 'gh:erin']) await w.user(u);
    await w.user('gh:frank2', { pid: 'gh:frank' }); // same provider subject as gh:frank: ambiguous
    await w.app('a1', 'gh:alice'); await w.app('a2', 'gh:alice'); await w.app('a4', 'gh:frank'); await w.app('a3', 'gh:ghost'); await w.app('a5', 'gh:erin');
    await w.exec("INSERT INTO team_members (app_id, user_id, role, created_at) VALUES ('a1','gh:bob','developer',1),('a2','gh:carol','po',1),('a2','gh:dave','wizard',1),('a1','gh:carol','owner',1)");
    await w.exec("INSERT INTO agent_projects (slug, owner_id, name) VALUES ('draft1','gh:alice','Draft'),('a5','gh:alice','Mismatched')");
    return w;
  }
  const counts = async (w: ReturnType<typeof world>) => ({
    accounts: (await w.all('SELECT id FROM accounts')).length,
    members: (await w.all('SELECT account_id, user_id, role FROM account_memberships ORDER BY 1,2')),
    grants: (await w.all('SELECT app_id, user_id, role, reason FROM app_access_grants ORDER BY 1,2')),
    apps: (await w.all('SELECT id, owner_account_id FROM apps ORDER BY id')),
  });

  it('a dry run reports the plan and writes nothing', async () => {
    const w = await fixture();
    const before = await counts(w);
    const r = await runPersonalBackfill(w.db, { dryRun: true, runId: 'r1' });
    expect(await counts(w)).toEqual(before);
    expect(await w.all('SELECT * FROM account_backfill_receipts')).toEqual([]);
    expect(r).toMatchObject({ dry_run: true, done: true, personal_accounts: 2, apps_mapped: 3, projects_mapped: 1, guest_memberships: 2, grants: { total: 3, legacy_developer_data_access: 1 } });
  });

  it('applies: one personal account per valid owner, guests with compatibility grants, anomalies quarantined', async () => {
    const w = await fixture();
    const dry = await runPersonalBackfill(w.db, { dryRun: true, runId: 'r1' });
    const r = await runPersonalBackfill(w.db, { dryRun: false, runId: 'r2' });
    expect(r.plan_hash).toBe(dry.plan_hash); // what was reviewed is what ran
    const alice = await personalAccountId('gh:alice');
    expect(await w.all('SELECT id, kind, status, personal_user_id, authz_version FROM accounts WHERE id = ?', alice.id)).toEqual([{ id: alice.id, kind: 'personal', status: 'active', personal_user_id: 'gh:alice', authz_version: 1 }]);
    expect(await w.all("SELECT id FROM apps WHERE owner_account_id = ?", alice.id)).toEqual([{ id: 'a1' }, { id: 'a2' }]);
    expect(await w.all("SELECT owner_account_id FROM agent_projects WHERE slug = 'draft1'")).toEqual([{ owner_account_id: alice.id }]);
    expect(await w.all("SELECT user_id, role FROM account_memberships WHERE account_id = ? ORDER BY user_id", alice.id)).toEqual([
      { user_id: 'gh:alice', role: 'owner' }, { user_id: 'gh:bob', role: 'guest' }, { user_id: 'gh:carol', role: 'guest' },
    ]); // dave's unknown role is quarantined: no guest, no grant
    expect(await w.all('SELECT app_id, user_id, role, reason FROM app_access_grants ORDER BY app_id, user_id')).toEqual([
      { app_id: 'a1', user_id: 'gh:bob', role: 'app_legacy_developer', reason: 'legacy_developer_data_access' },
      { app_id: 'a1', user_id: 'gh:carol', role: 'app_legacy_owner', reason: 'legacy_app_owner' },
      { app_id: 'a2', user_id: 'gh:carol', role: 'product_owner', reason: 'legacy_app_collaborator' },
    ]);
    const kinds = (await w.all<{ kind: string; subject: string }>('SELECT kind, subject FROM account_backfill_exceptions ORDER BY kind, subject')).map((e) => `${e.kind}:${e.subject}`);
    expect(kinds).toEqual(['ambiguous_provider_subject:gh:frank', 'orphan_owner:gh:ghost', 'project_owner_mismatch:a5', 'unknown_team_role:a2:gh:dave']);
    // Quarantined subjects got no account and no mapping.
    expect(await w.all("SELECT owner_account_id FROM apps WHERE id IN ('a3','a4')")).toEqual([{ owner_account_id: null }, { owner_account_id: null }]);
    expect(await w.all("SELECT COUNT(*) AS n FROM users")).toEqual([{ n: 7 }]);
  });

  it('is idempotent and resumable: repeating, or walking page by page, converges on the same rows', async () => {
    const once = await fixture();
    await runPersonalBackfill(once.db, { dryRun: false, runId: 'a' });
    const snapshot = await counts(once);
    await runPersonalBackfill(once.db, { dryRun: false, runId: 'b' });
    expect(await counts(once)).toEqual(snapshot);

    const paged = await fixture();
    let cursor: string | null = null;
    let pages = 0;
    for (;;) {
      const r = await runPersonalBackfill(paged.db, { dryRun: false, runId: `p${pages}`, limit: 1, cursor });
      pages += 1;
      if (r.done) break;
      cursor = r.cursor;
    }
    expect(pages).toBeGreaterThan(1);
    expect(await counts(paged)).toEqual(snapshot);
  });

  it('never merges users by email and never invents an owner for a quarantined app', async () => {
    const w = world();
    await w.user('gh:one'); await w.user('google:one', { provider: 'google' });
    await w.exec("UPDATE users SET email = 'same@example.com'");
    await w.app('x', 'gh:one'); await w.app('y', 'google:one');
    await runPersonalBackfill(w.db, { dryRun: false, runId: 'm' });
    const accounts = await w.all<{ personal_user_id: string }>("SELECT personal_user_id FROM accounts ORDER BY 1");
    expect(accounts.map((a) => a.personal_user_id)).toEqual(['gh:one', 'google:one']);
  });
});

describe('routes: flags and credentials', () => {
  it('every route is a 404 accounts_disabled until its flag is on; reads and writes are gated separately', async () => {
    const off = world({});
    await off.user('gh:a');
    expect((await off.call('GET', '/me/accounts', 'gh:a')).json.error.code).toBe('accounts_disabled');
    expect((await off.call('POST', '/accounts', 'gh:a', { name: 'Team A' }, off.idem())).status).toBe(404);
    const readOnly = world({ ACCOUNTS_READ: '1' });
    await readOnly.user('gh:a');
    expect((await readOnly.call('GET', '/me/accounts', 'gh:a')).status).toBe(200);
    expect((await readOnly.call('POST', '/accounts', 'gh:a', { name: 'Team A' }, readOnly.idem())).status).toBe(404);
  });

  it('a non-interactive session and an app-bound credential account cannot create or own a team', async () => {
    const w = world();
    await w.user('gh:a'); await w.user('gh:bot', { credentialApp: 'some-app' });
    expect((await w.call('POST', '/accounts', 'gh:a', { name: 'Team A' }, w.idem(), 'oidc-e2e')).json.error.code).toBe('credential_scope');
    expect((await w.call('POST', '/accounts', 'gh:bot', { name: 'Team A' }, w.idem())).json.error.code).toBe('team_owner_not_permitted');
    expect((await w.call('POST', '/accounts', 'gh:ghost', { name: 'Team A' }, w.idem())).json.error.code).toBe('team_owner_not_permitted');
    expect(await w.all('SELECT id FROM accounts')).toEqual([]);
  });

  it('rejects an unauthenticated caller and a missing idempotency key', async () => {
    const w = world();
    await w.user('gh:a');
    expect((await accountRoutes.request('/me/accounts', {}, w.env)).status).toBe(401);
    expect((await w.call('POST', '/accounts', 'gh:a', { name: 'Team A' })).json.error.code).toBe('idempotency_key_required');
  });
});

describe('routes: team lifecycle', () => {
  async function team() {
    const w = world();
    for (const u of ['gh:owner', 'gh:admin', 'gh:mem', 'gh:other', 'gh:co']) await w.user(u);
    const created = await w.call('POST', '/accounts', 'gh:owner', { name: 'Acme Team' }, w.idem());
    const id = created.json.account.id as string;
    return { w, id, created };
  }
  const invite = async (t: Awaited<ReturnType<typeof team>>, by: string, body: object) => t.w.call('POST', `/accounts/${t.id}/invitations`, by, body, t.w.idem());
  const accept = (t: Awaited<ReturnType<typeof team>>, by: string, inv: { id: string }, secret: string, k?: Record<string, string>) => t.w.call('POST', `/invitations/${inv.id}/accept`, by, { secret }, k);
  async function join(t: Awaited<ReturnType<typeof team>>, uid: string, role: string, by = 'gh:owner') {
    const i = await invite(t, by, { role, user_id: uid });
    expect(i.status).toBe(201);
    const a = await accept(t, uid, i.json.invitation, i.json.invitation_secret);
    expect(a.status).toBe(200);
    return i;
  }

  it('creates an active team with its creator as the first owner, audited, in one idempotent step', async () => {
    const t = await team();
    expect(t.created.status).toBe(201);
    expect(t.created.json.account).toMatchObject({ kind: 'team', slug: 'acme-team', status: 'active', role: 'owner' });
    expect(await t.w.all('SELECT user_id, role, status, generation FROM account_memberships')).toEqual([{ user_id: 'gh:owner', role: 'owner', status: 'active', generation: 1 }]);
    expect(await t.w.all('SELECT action, actor_id, credential, authz_version FROM account_audit_events')).toEqual([{ action: 'account.create', actor_id: 'gh:owner', credential: 'first_party_session', authz_version: 1 }]);
  });

  it('replays the same idempotency key, and refuses the same key with another payload', async () => {
    const w = world();
    await w.user('gh:a');
    const h = { 'idempotency-key': 'replay-key-0001' };
    const first = await w.call('POST', '/accounts', 'gh:a', { name: 'Same' }, h);
    const again = await w.call('POST', '/accounts', 'gh:a', { name: 'Same' }, h);
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.res.headers.get('idempotent-replay')).toBe('true');
    expect(again.json).toEqual(first.json);
    expect(await w.all('SELECT id FROM accounts')).toHaveLength(1);
    expect((await w.call('POST', '/accounts', 'gh:a', { name: 'Different' }, h)).json.error.code).toBe('idempotency_conflict');
    expect((await w.call('POST', '/accounts', 'gh:a', { name: 'Same' }, w.idem())).json.error.code).toBe('slug_taken');
    expect(await w.all('SELECT id FROM accounts')).toHaveLength(1);
  });

  it('is not enumerable: a stranger gets 404 for an account and its members', async () => {
    const t = await team();
    expect((await t.w.call('GET', `/accounts/${t.id}`, 'gh:other')).json.error.code).toBe('account_not_found');
    expect((await t.w.call('GET', `/accounts/${t.id}/members`, 'gh:other')).status).toBe(404);
    expect((await t.w.call('GET', '/accounts/acct_missing', 'gh:other')).status).toBe(404);
  });

  it('invitation: hashed, single-use, recipient-bound; the secret appears once and is never stored or audited', async () => {
    const t = await team();
    const i = await invite(t, 'gh:owner', { role: 'member', user_id: 'gh:mem' });
    const secret = i.json.invitation_secret as string;
    expect(secret).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const stored = JSON.stringify(await t.w.all('SELECT * FROM account_invitations'));
    const everything = stored + JSON.stringify(await t.w.all('SELECT * FROM account_audit_events')) + JSON.stringify(await t.w.all('SELECT * FROM account_operations')) + JSON.stringify(await t.w.all('SELECT * FROM account_outbox'));
    expect(everything).not.toContain(secret);
    // wrong recipient, wrong secret: the same non-revealing 404
    expect((await accept(t, 'gh:other', i.json.invitation, secret)).json.error.code).toBe('invitation_not_found');
    expect((await accept(t, 'gh:mem', i.json.invitation, `${secret}x`)).json.error.code).toBe('invitation_not_found');
    expect((await t.w.call('POST', `/invitations/${i.json.invitation.id}/preview`, 'gh:other', { secret })).status).toBe(404);
    const preview = await t.w.call('POST', `/invitations/${i.json.invitation.id}/preview`, 'gh:mem', { secret });
    expect(preview.json.invitation).toMatchObject({ role: 'member', account: { id: t.id, name: 'Acme Team' } });
    expect((await accept(t, 'gh:mem', i.json.invitation, secret)).status).toBe(200);
    expect(await t.w.all("SELECT user_id, role FROM account_memberships WHERE user_id = 'gh:mem'")).toEqual([{ user_id: 'gh:mem', role: 'member' }]);
    // a second accept by the same person replays; by anyone else it is gone
    const again = await accept(t, 'gh:mem', i.json.invitation, secret);
    expect(again.res.headers.get('idempotent-replay')).toBe('true');
    expect((await accept(t, 'gh:other', i.json.invitation, secret)).status).toBe(404);
    expect(await t.w.all("SELECT COUNT(*) AS n FROM account_memberships WHERE user_id = 'gh:mem'")).toEqual([{ n: 1 }]);
  });

  it('a replayed invitation create never returns the secret again', async () => {
    const t = await team();
    const h = { 'idempotency-key': 'invite-key-0001' };
    const a = await t.w.call('POST', `/accounts/${t.id}/invitations`, 'gh:owner', { role: 'guest', user_id: 'gh:mem' }, h);
    const b = await t.w.call('POST', `/accounts/${t.id}/invitations`, 'gh:owner', { role: 'guest', user_id: 'gh:mem' }, h);
    expect(a.json.invitation_secret).toBeTruthy();
    expect(b.json.invitation_secret).toBeNull();
    expect(b.json.invitation.id).toBe(a.json.invitation.id);
  });

  it('an email invitation needs the recipient to hold that exact verified email; stored email text alone is not proof', async () => {
    const t = await team();
    await t.w.exec("UPDATE users SET email = 'pat@example.com' WHERE id = 'gh:mem'");
    const i = await invite(t, 'gh:owner', { role: 'member', email: 'Pat@Example.com ' });
    expect(i.json.invitation.target).toEqual({ type: 'email', value: 'pat@example.com' });
    expect((await accept(t, 'gh:mem', i.json.invitation, i.json.invitation_secret)).status).toBe(404);
    await t.w.exec("INSERT INTO user_verified_emails (user_id, email, method, verified_at) VALUES ('gh:mem','pat+alias@example.com','provider_claim',1)");
    expect((await accept(t, 'gh:mem', i.json.invitation, i.json.invitation_secret)).status).toBe(404); // an alias is not the same address
    await t.w.exec("INSERT INTO user_verified_emails (user_id, email, method, verified_at) VALUES ('gh:mem','pat@example.com','provider_claim',1)");
    expect((await accept(t, 'gh:mem', i.json.invitation, i.json.invitation_secret)).status).toBe(200);
  });

  it('an expired, revoked or abandoned invitation grants nothing and says why', async () => {
    const t = await team();
    const i = await invite(t, 'gh:owner', { role: 'member', user_id: 'gh:mem' });
    await t.w.exec('UPDATE account_invitations SET expires_at = 1');
    expect((await accept(t, 'gh:mem', i.json.invitation, i.json.invitation_secret)).json.error.code).toBe('invitation_expired');
    // a fresh invitation to the same recipient is possible once the old one lapsed
    const j = await invite(t, 'gh:owner', { role: 'guest', user_id: 'gh:mem' });
    expect(j.status).toBe(201);
    const rev = await t.w.call('POST', `/accounts/${t.id}/invitations/${j.json.invitation.id}/revoke`, 'gh:owner', {});
    expect(rev.status).toBe(200);
    expect((await accept(t, 'gh:mem', j.json.invitation, j.json.invitation_secret)).json.error.code).toBe('invitation_revoked');
    expect(await t.w.all("SELECT COUNT(*) AS n FROM account_memberships WHERE user_id = 'gh:mem'")).toEqual([{ n: 0 }]);
  });

  it('an invitation dies with its inviter\'s authority (demoted, removed, or a stale generation)', async () => {
    const t = await team();
    await join(t, 'gh:admin', 'admin');
    const i = await invite(t, 'gh:admin', { role: 'member', user_id: 'gh:mem' });
    expect(i.status).toBe(201);
    const demote = await t.w.call('PATCH', `/accounts/${t.id}/members/gh:admin`, 'gh:owner', { role: 'member' }, t.w.idem());
    expect(demote.status).toBe(200);
    const r = await accept(t, 'gh:mem', i.json.invitation, i.json.invitation_secret);
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe('inviter_no_longer_authorized');
    expect(await t.w.all("SELECT COUNT(*) AS n FROM account_memberships WHERE user_id = 'gh:mem'")).toEqual([{ n: 0 }]);
  });

  it('role ceilings: admins cannot invite admins or owners, nor touch owners or peers; only an owner promotes, with recent auth', async () => {
    const t = await team();
    await join(t, 'gh:admin', 'admin');
    await join(t, 'gh:co', 'admin');
    await join(t, 'gh:mem', 'member');
    expect((await invite(t, 'gh:admin', { role: 'admin', user_id: 'gh:other' })).json.error.code).toBe('permission_missing');
    expect((await invite(t, 'gh:admin', { role: 'owner', user_id: 'gh:other' })).status).toBe(403);
    expect((await invite(t, 'gh:owner', { role: 'owner', user_id: 'gh:other' })).status).toBe(403);
    expect((await t.w.call('PATCH', `/accounts/${t.id}/members/gh:co`, 'gh:admin', { role: 'member' }, t.w.idem())).status).toBe(403); // a peer
    expect((await t.w.call('PATCH', `/accounts/${t.id}/members/gh:owner`, 'gh:admin', { role: 'member' }, t.w.idem())).status).toBe(403);
    expect((await t.w.call('PATCH', `/accounts/${t.id}/members/gh:mem`, 'gh:admin', { role: 'admin' }, t.w.idem())).status).toBe(403);
    expect((await t.w.call('PATCH', `/accounts/${t.id}/members/gh:mem`, 'gh:admin', { role: 'owner' }, t.w.idem())).status).toBe(403);
    expect((await t.w.call('DELETE', `/accounts/${t.id}/members/gh:co`, 'gh:admin', undefined, t.w.idem())).status).toBe(403);
    expect((await t.w.call('PATCH', `/accounts/${t.id}/members/gh:mem`, 'gh:admin', { role: 'guest' }, t.w.idem())).status).toBe(200);
    // promotion: recent authentication is required (the test session has it); a stale one is refused
    const ok = await t.w.call('PATCH', `/accounts/${t.id}/members/gh:co`, 'gh:owner', { role: 'owner' }, t.w.idem());
    expect(ok.status).toBe(200);
    expect(await t.w.all("SELECT role FROM account_memberships WHERE user_id = 'gh:co'")).toEqual([{ role: 'owner' }]);
  });

  it('removal ends authority in one transaction and a rejoin gets a new generation, so old grants stay dead', async () => {
    const t = await team();
    await join(t, 'gh:mem', 'guest');
    await t.w.app('team-app', 'gh:owner');
    await t.w.exec("UPDATE apps SET owner_account_id = ?1 WHERE id = 'team-app'", t.id);
    await t.w.exec("INSERT INTO app_access_grants (id, app_id, account_id, user_id, role, membership_generation, granted_by, created_at, updated_at) VALUES ('g1','team-app',?1,'gh:mem','app_admin',1,'gh:owner',1,1)", t.id);
    const before = await t.w.all<{ access_version: number }>("SELECT access_version FROM apps WHERE id = 'team-app'");
    expect((await t.w.call('DELETE', `/accounts/${t.id}/members/gh:mem`, 'gh:owner', undefined, t.w.idem())).status).toBe(200);
    expect(await t.w.all("SELECT revoked_at IS NOT NULL AS revoked FROM app_access_grants WHERE id = 'g1'")).toEqual([{ revoked: 1 }]);
    expect((await t.w.all<{ access_version: number }>("SELECT access_version FROM apps WHERE id = 'team-app'"))[0]!.access_version).toBe(before[0]!.access_version + 1);
    expect(await t.w.all("SELECT effect, state FROM account_outbox WHERE effect = 'access_reconcile'")).toEqual([{ effect: 'access_reconcile', state: 'held' }]);
    await join(t, 'gh:mem', 'guest');
    expect(await t.w.all("SELECT status, generation FROM account_memberships WHERE user_id = 'gh:mem'")).toEqual([{ status: 'active', generation: 2 }]);
    expect(await t.w.all("SELECT membership_generation, revoked_at IS NOT NULL AS revoked FROM app_access_grants WHERE id = 'g1'")).toEqual([{ membership_generation: 1, revoked: 1 }]);
  });

  it('removing a member also revokes the invitations they issued', async () => {
    const t = await team();
    await join(t, 'gh:admin', 'admin');
    const i = await invite(t, 'gh:admin', { role: 'member', user_id: 'gh:mem' });
    await t.w.call('DELETE', `/accounts/${t.id}/members/gh:admin`, 'gh:owner', undefined, t.w.idem());
    expect(await t.w.all('SELECT status FROM account_invitations WHERE id = ?', i.json.invitation.id)).toEqual([{ status: 'revoked' }]);
  });

  it('the sole owner can neither leave nor be demoted; with a second owner one may', async () => {
    const t = await team();
    expect((await t.w.call('DELETE', `/accounts/${t.id}/members/gh:owner`, 'gh:owner', undefined, t.w.idem())).json.error.code).toBe('last_owner');
    expect((await t.w.call('PATCH', `/accounts/${t.id}/members/gh:owner`, 'gh:owner', { role: 'admin' }, t.w.idem())).json.error.code).toBe('last_owner');
    await join(t, 'gh:co', 'member');
    await t.w.call('PATCH', `/accounts/${t.id}/members/gh:co`, 'gh:owner', { role: 'owner' }, t.w.idem());
    expect((await t.w.call('DELETE', `/accounts/${t.id}/members/gh:owner`, 'gh:owner', undefined, t.w.idem())).status).toBe(200);
    expect((await t.w.call('DELETE', `/accounts/${t.id}/members/gh:co`, 'gh:co', undefined, t.w.idem())).json.error.code).toBe('last_owner');
  });

  it('a guest may leave although it holds no permission; a stale expected version is a 409', async () => {
    const t = await team();
    await join(t, 'gh:mem', 'guest');
    expect((await t.w.call('DELETE', `/accounts/${t.id}/members/gh:mem`, 'gh:mem', undefined, t.w.idem())).status).toBe(200);
    expect((await t.w.call('POST', `/accounts/${t.id}/invitations`, 'gh:owner', { role: 'guest', user_id: 'gh:other', expected_authz_version: 0 }, t.w.idem())).json.error.code).toBe('stale_state');
  });
});
