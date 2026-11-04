import { createExecutionContext, env as providedEnv } from 'cloudflare:test';
import { credentialContext, mintSession, type CredentialContextClaim } from '@proappstore/build-core';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import worker from '../../../backend/src/index';
import { requireAppAccess, type TeamRole } from '../../../backend/src/lib/auth';
import { runPersonalBackfill } from '../../../backend/src/lib/accounts/backfill';
import { authorize, classifyDivergence, LEGACY_MIN_ROLE_PERMISSION } from '../../../backend/src/lib/accounts/authorize';
import { asAccountId, asAppId, asUserId } from '../../../backend/src/lib/accounts/contract';
import type { Env } from '../../../backend/src/types';
import { BASE, resetTables, seedApp, seedUser } from './helpers';

// #534 T02-T04 on real D1 in workerd. The handler runs in-process on the real binding, so parallel
// requests interleave at every await the way concurrent requests do; the invariants asserted here are the
// ones a mock cannot prove: a guarded batch is one transaction, a trigger aborts the losing write.

const base = providedEnv as unknown as Env;
const on = { ...base, ACCOUNTS_WRITE: '1' } as unknown as Env;
const DB = base.DB;

const ACCOUNT_TABLES = ['account_backfill_exceptions', 'account_backfill_receipts', 'user_verified_emails', 'account_outbox', 'account_operations', 'app_access_grants', 'account_invitations'];

/** The audit trail is append-only by trigger, so cleanup lifts that trigger for the moment and restores it. */
async function purge(): Promise<void> {
  await DB.prepare("UPDATE accounts SET status = 'deleted' WHERE status <> 'deleted'").run();
  await DB.prepare('DROP TRIGGER trg_account_audit_no_delete').run();
  await DB.prepare('DELETE FROM account_audit_events').run();
  await DB.prepare("CREATE TRIGGER trg_account_audit_no_delete BEFORE DELETE ON account_audit_events BEGIN SELECT RAISE(ABORT, 'account_audit_events is append-only'); END").run();
  for (const t of ACCOUNT_TABLES) await DB.prepare(`DELETE FROM ${t}`).run();
  await DB.prepare('DELETE FROM account_memberships').run();
  await DB.prepare('DELETE FROM accounts').run();
  for (const t of ['team_members', 'agent_projects']) await DB.prepare(`DELETE FROM ${t}`).run();
}

beforeEach(async () => { await purge(); await resetTables(); });
afterAll(async () => { await purge(); await resetTables(); });

let seq = 0;
const key = () => `rt-key-${++seq}-${crypto.randomUUID()}`;
// #535: real D1/workerd route calls go through the actual `caller()`, which derives its `Principal`
// from the session's verified `cred` claim — defaulting here to first-party, since that's what the
// overwhelming majority of these tests exercise. Pass `cred` explicitly for a different kind.
const token = (uid: string, cred: CredentialContextClaim = credentialContext('first_party_session')) =>
  mintSession({ uid, login: uid, avatarUrl: null, roles: ['user'], auth_time: Math.floor(Date.now() / 1000), auth_method: 'github', cred }, base.SESSION_SIGNING_KEY);

async function call(uid: string, method: string, path: string, body?: unknown, opts: { env?: Env; headers?: Record<string, string>; cred?: CredentialContextClaim } = {}) {
  const res = await worker.fetch(new Request(`${BASE}/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${await token(uid, opts.cred)}`, ...(opts.headers ?? {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }), opts.env ?? on, createExecutionContext());
  return { status: res.status, headers: res.headers, json: (await res.json().catch(() => null)) as any };
}
const post = (uid: string, path: string, body: unknown, k = key()) => call(uid, 'POST', path, body, { headers: { 'idempotency-key': k } });
const patch = (uid: string, path: string, body: unknown) => call(uid, 'PATCH', path, body, { headers: { 'idempotency-key': key() } });
const del = (uid: string, path: string) => call(uid, 'DELETE', path, undefined, { headers: { 'idempotency-key': key() } });

const rows = async <T>(sql: string, ...p: unknown[]) => ((await DB.prepare(sql).bind(...p).all<T>()).results ?? []) as T[];
const activeOwners = async (acct: string) => (await rows<{ user_id: string }>("SELECT user_id FROM account_memberships WHERE account_id = ? AND role = 'owner' AND status = 'active' ORDER BY user_id", acct)).map((r) => r.user_id);

async function createTeam(owner: string, name = `Team ${crypto.randomUUID().slice(0, 8)}`): Promise<string> {
  await seedUser(owner);
  const r = await post(owner, '/accounts', { name });
  expect(r.status).toBe(201);
  return r.json.account.id as string;
}
async function addMember(acct: string, by: string, uid: string, role: string): Promise<void> {
  await seedUser(uid);
  const i = await post(by, `/accounts/${acct}/invitations`, { role, user_id: uid });
  expect(i.status).toBe(201);
  const a = await post(uid, `/invitations/${i.json.invitation.id}/accept`, { secret: i.json.invitation_secret });
  expect(a.status).toBe(200);
}
async function addOwner(acct: string, owner: string, uid: string): Promise<void> {
  await addMember(acct, owner, uid, 'admin');
  expect((await patch(owner, `/accounts/${acct}/members/${uid}`, { role: 'owner' })).status).toBe(200);
}

describe('defaults', () => {
  it('team and account routes are off unless a flag is set', async () => {
    await seedUser('gh:flag');
    const r = await call('gh:flag', 'GET', '/me/accounts', undefined, { env: base });
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe('accounts_disabled');
    expect((await call('gh:flag', 'POST', '/accounts', { name: 'Nope' }, { env: base, headers: { 'idempotency-key': key() } })).status).toBe(404);
    expect(await rows('SELECT id FROM accounts')).toEqual([]);
  });
});

/** Exactly one request commits; the other is refused. Which refusal depends on whether it lost at the guard (409) or read the new state first (403/404). */
function oneWins(res: { status: number }[], note: string): void {
  expect(res.filter((r) => r.status === 200), note).toHaveLength(1);
  expect(res.filter((r) => r.status !== 200).every((r) => [403, 404, 409].includes(r.status)), note).toBe(true);
}

describe('simultaneous owner changes (design §11)', () => {
  it('two owners leaving at once: exactly one succeeds and an owner always remains', async () => {
    for (let i = 0; i < 6; i += 1) {
      const a = `gh:lo-a${i}`; const b = `gh:lo-b${i}`;
      const acct = await createTeam(a);
      await addOwner(acct, a, b);
      const res = await Promise.all([del(a, `/accounts/${acct}/members/${a}`), del(b, `/accounts/${acct}/members/${b}`)]);
      oneWins(res, `iteration ${i}`);
      expect(res.find((r) => r.status !== 200)!.json.error.code).toBe('last_owner');
      expect(await activeOwners(acct)).toHaveLength(1);
    }
  });

  it('two owners removing each other at once: the loser acts with revoked authority and is refused', async () => {
    for (let i = 0; i < 6; i += 1) {
      const a = `gh:mr-a${i}`; const b = `gh:mr-b${i}`;
      const acct = await createTeam(a);
      await addOwner(acct, a, b);
      const res = await Promise.all([del(a, `/accounts/${acct}/members/${b}`), del(b, `/accounts/${acct}/members/${a}`)]);
      oneWins(res, `iteration ${i}`);
      expect(await activeOwners(acct)).toHaveLength(1);
      const audits = await rows<{ action: string }>("SELECT action FROM account_audit_events WHERE account_id = ? AND action = 'member.remove'", acct);
      expect(audits).toHaveLength(1); // only the committed removal is claimed in the audit
    }
  });

  it('two owners demoting each other at once cannot leave the team ownerless', async () => {
    for (let i = 0; i < 6; i += 1) {
      const a = `gh:dm-a${i}`; const b = `gh:dm-b${i}`;
      const acct = await createTeam(a);
      await addOwner(acct, a, b);
      const res = await Promise.all([patch(a, `/accounts/${acct}/members/${b}`, { role: 'admin' }), patch(b, `/accounts/${acct}/members/${a}`, { role: 'admin' })]);
      oneWins(res, `iteration ${i}`);
      expect(await activeOwners(acct)).toHaveLength(1);
    }
  });

  it('three owners removing each other in a ring leave at least one', async () => {
    const [a, b, c] = ['gh:ring-a', 'gh:ring-b', 'gh:ring-c'];
    const acct = await createTeam(a!);
    await addOwner(acct, a!, b!);
    await addOwner(acct, a!, c!);
    await Promise.all([del(a!, `/accounts/${acct}/members/${b}`), del(b!, `/accounts/${acct}/members/${c}`), del(c!, `/accounts/${acct}/members/${a}`)]);
    expect((await activeOwners(acct)).length).toBeGreaterThanOrEqual(1);
  });
});

describe('invitation acceptance (design §5)', () => {
  it('the same recipient accepting many times at once joins exactly once', async () => {
    const acct = await createTeam('gh:ia-owner');
    await seedUser('gh:ia-r');
    const i = await post('gh:ia-owner', `/accounts/${acct}/invitations`, { role: 'member', user_id: 'gh:ia-r' });
    const res = await Promise.all(Array.from({ length: 6 }, () => post('gh:ia-r', `/invitations/${i.json.invitation.id}/accept`, { secret: i.json.invitation_secret }, key())));
    expect(res.map((r) => r.status), JSON.stringify(res.map((r) => r.json?.error))).toEqual(res.map(() => 200)); // one commit, the rest replay it
    expect(await rows("SELECT role, generation FROM account_memberships WHERE user_id = 'gh:ia-r'")).toEqual([{ role: 'member', generation: 1 }]);
    expect(await rows("SELECT id FROM account_audit_events WHERE action = 'invitation.accept'")).toHaveLength(1);
    expect(await rows('SELECT authz_version FROM accounts WHERE id = ?', acct)).toEqual([{ authz_version: 2 }]); // create + one join
  });

  it('two users who both hold the invited verified email race: one wins, the other is told it was used', async () => {
    const acct = await createTeam('gh:ie-owner');
    for (const u of ['gh:ie-1', 'gh:ie-2']) {
      await seedUser(u);
      await DB.prepare("INSERT INTO user_verified_emails (user_id, email, method, verified_at) VALUES (?, 'shared@example.com', 'pas_email_proof', 1)").bind(u).run();
    }
    const i = await post('gh:ie-owner', `/accounts/${acct}/invitations`, { role: 'guest', email: 'shared@example.com' });
    const res = await Promise.all(['gh:ie-1', 'gh:ie-2'].map((u) => post(u, `/invitations/${i.json.invitation.id}/accept`, { secret: i.json.invitation_secret })));
    expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(res.find((r) => r.status === 409)!.json.error.code).toBe('invitation_not_pending');
    expect(await rows("SELECT user_id FROM account_memberships WHERE role = 'guest' AND account_id = ?", acct)).toHaveLength(1);
  });

  it('strangers racing a targeted invitation are all refused without learning anything', async () => {
    const acct = await createTeam('gh:is-owner');
    await seedUser('gh:is-r');
    const i = await post('gh:is-owner', `/accounts/${acct}/invitations`, { role: 'admin', user_id: 'gh:is-r' });
    const res = await Promise.all(['gh:is-x', 'gh:is-y', 'gh:is-z'].map(async (u) => { await seedUser(u); return post(u, `/invitations/${i.json.invitation.id}/accept`, { secret: i.json.invitation_secret }); }));
    expect(res.every((r) => r.status === 404 && r.json.error.code === 'invitation_not_found')).toBe(true);
    expect(await rows("SELECT user_id FROM account_memberships WHERE account_id = ? AND user_id <> 'gh:is-owner'", acct)).toEqual([]);
    expect((await post('gh:is-r', `/invitations/${i.json.invitation.id}/accept`, { secret: i.json.invitation_secret })).status).toBe(200);
  });

  it('accepting while the inviter is removed: the member exists exactly when the accept succeeded', async () => {
    let joined = 0; let refused = 0;
    for (let n = 0; n < 8; n += 1) {
      const owner = `gh:sr-o${n}`; const adm = `gh:sr-a${n}`; const rcp = `gh:sr-r${n}`;
      const acct = await createTeam(owner);
      await addMember(acct, owner, adm, 'admin');
      await seedUser(rcp);
      const i = await post(adm, `/accounts/${acct}/invitations`, { role: 'member', user_id: rcp });
      const [rm, ac] = await Promise.all([
        del(owner, `/accounts/${acct}/members/${adm}`),
        post(rcp, `/invitations/${i.json.invitation.id}/accept`, { secret: i.json.invitation_secret }),
      ]);
      expect(rm.status).toBe(200);
      const member = await rows("SELECT 1 FROM account_memberships WHERE account_id = ? AND user_id = ? AND status = 'active'", acct, rcp);
      if (ac.status === 200) { joined += 1; expect(member).toHaveLength(1); } else { refused += 1; expect(['invitation_revoked', 'inviter_no_longer_authorized']).toContain(ac.json.error.code); expect(member).toEqual([]); }
      // either way no usable invitation is left behind
      expect(await rows("SELECT id FROM account_invitations WHERE account_id = ? AND status = 'pending'", acct)).toEqual([]);
    }
    expect(joined + refused).toBe(8);
  });

  it('a removed inviter cannot be used afterwards: a late accept is refused', async () => {
    const acct = await createTeam('gh:li-o');
    await addMember(acct, 'gh:li-o', 'gh:li-a', 'admin');
    await seedUser('gh:li-r');
    const i = await post('gh:li-a', `/accounts/${acct}/invitations`, { role: 'member', user_id: 'gh:li-r' });
    await del('gh:li-o', `/accounts/${acct}/members/gh:li-a`);
    const r = await post('gh:li-r', `/invitations/${i.json.invitation.id}/accept`, { secret: i.json.invitation_secret });
    expect(r.status).toBe(409); // revoked together with the inviter's authority
    expect(r.json.error.code).toBe('invitation_revoked');
    expect(await rows("SELECT 1 FROM account_memberships WHERE user_id = 'gh:li-r'")).toEqual([]);
  });
});

describe('idempotency', () => {
  it('the same key sent concurrently creates one team and answers every request alike', async () => {
    await seedUser('gh:id-1');
    const k = key();
    const res = await Promise.all(Array.from({ length: 6 }, () => post('gh:id-1', '/accounts', { name: 'Idem Team' }, k)));
    expect(res.every((r) => r.status === 201 || r.status === 200), JSON.stringify(res.map((r) => [r.status, r.json?.error]))).toBe(true);
    expect(res.filter((r) => r.status === 201)).toHaveLength(1); // one commit, the rest replay it
    expect(new Set(res.map((r) => r.json.account.id)).size).toBe(1);
    expect(await rows('SELECT id FROM accounts')).toHaveLength(1);
    expect(await rows("SELECT id FROM account_audit_events WHERE action = 'account.create'")).toHaveLength(1);
  });

  it('a key reused for another payload is a 409, concurrently as well', async () => {
    await seedUser('gh:id-2');
    const k = key();
    const [a, b] = await Promise.all([post('gh:id-2', '/accounts', { name: 'First Name' }, k), post('gh:id-2', '/accounts', { name: 'Second Name' }, k)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await rows('SELECT id FROM accounts')).toHaveLength(1);
  });

  it('two people choosing one handle at once: one team is made', async () => {
    await seedUser('gh:hd-1'); await seedUser('gh:hd-2');
    const res = await Promise.all([post('gh:hd-1', '/accounts', { name: 'Handle', slug: 'same-handle' }), post('gh:hd-2', '/accounts', { name: 'Handle', slug: 'same-handle' })]);
    expect(res.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await rows("SELECT id FROM accounts WHERE slug = 'same-handle'")).toHaveLength(1);
    expect(await rows('SELECT user_id FROM account_memberships')).toHaveLength(1); // the loser left no half-made team behind
  });
});

describe('cross-account and credential isolation', () => {
  it('an owner of one team has no authority in another, whatever the request names', async () => {
    const mine = await createTeam('gh:xa-1');
    const theirs = await createTeam('gh:xa-2');
    await seedUser('gh:xa-v');
    expect((await call('gh:xa-1', 'GET', `/accounts/${theirs}`)).status).toBe(404);
    expect((await call('gh:xa-1', 'GET', `/accounts/${theirs}/members`)).status).toBe(404);
    expect((await post('gh:xa-1', `/accounts/${theirs}/invitations`, { role: 'guest', user_id: 'gh:xa-v' })).status).toBe(404);
    expect((await patch('gh:xa-1', `/accounts/${theirs}/members/gh:xa-2`, { role: 'guest' })).status).toBe(404);
    expect((await del('gh:xa-1', `/accounts/${theirs}/members/gh:xa-2`)).status).toBe(404);
    // an invitation of the other team cannot be revoked through my team's path
    await seedUser('gh:xa-w');
    const i = await post('gh:xa-2', `/accounts/${theirs}/invitations`, { role: 'guest', user_id: 'gh:xa-w' });
    expect((await post('gh:xa-1', `/accounts/${mine}/invitations/${i.json.invitation.id}/revoke`, {})).status).toBe(404);
    expect(await rows("SELECT status FROM account_invitations WHERE id = ?", i.json.invitation.id)).toEqual([{ status: 'pending' }]);
  });

  it('a user id in the body never changes who is acting', async () => {
    const acct = await createTeam('gh:bd-owner');
    await seedUser('gh:bd-evil'); await seedUser('gh:bd-t');
    const r = await post('gh:bd-evil', `/accounts/${acct}/invitations`, { role: 'admin', user_id: 'gh:bd-t', inviter_id: 'gh:bd-owner', actor: 'gh:bd-owner', created_by: 'gh:bd-owner' });
    expect(r.status).toBe(404);
    expect(await rows('SELECT id FROM account_invitations')).toEqual([]);
  });

  it('a non-interactive session and a bogus bearer cannot govern; governance needs a first-party session', async () => {
    const acct = await createTeam('gh:cs-o');
    await seedUser('gh:cs-t');
    const viaSess = await call('gh:cs-o', 'POST', `/accounts/${acct}/invitations`, { role: 'guest', user_id: 'gh:cs-t' }, { cred: credentialContext('workload_session'), headers: { 'idempotency-key': key() } });
    expect(viaSess.status).toBe(403);
    expect(viaSess.json.error.code).toBe('credential_scope');
    expect((await call('gh:cs-o', 'POST', '/accounts', { name: 'Via Team' }, { cred: credentialContext('workload_session'), headers: { 'idempotency-key': key() } })).json.error.code).toBe('credential_scope');
    const bogus = await worker.fetch(new Request(`${BASE}/v1/me/accounts`, { headers: { authorization: 'Bearer pas_app_token_not_a_session' } }), on, createExecutionContext());
    expect(bogus.status).toBe(401);
  });

  it('the resolver denies an app-bound credential governance and a different app', async () => {
    const acct = await createTeam('gh:ab-o');
    await seedApp('ab-app', 'gh:ab-o'); await seedApp('ab-other', 'gh:ab-o');
    await DB.prepare('UPDATE apps SET owner_account_id = ? WHERE id IN (?, ?)').bind(acct, 'ab-app', 'ab-other').run();
    const p = { userId: asUserId('gh:ab-o'), credential: 'app_bound' as const, boundAppId: asAppId('ab-app') };
    expect(await authorize(DB, p, { kind: 'account', accountId: asAccountId(acct) }, 'account.members.manage')).toMatchObject({ allowed: false, reason: 'credential_scope' });
    expect(await authorize(DB, p, { kind: 'app', appId: asAppId('ab-other') }, 'app.source.write')).toMatchObject({ allowed: false, reason: 'credential_scope' });
    expect((await authorize(DB, p, { kind: 'app', appId: asAppId('ab-app') }, 'app.source.write')).allowed).toBe(true);
  });
});

describe('removal and rejoin (design §5)', () => {
  it('a rejoining member does not get the grants of the earlier stint, even if the old row is revived', async () => {
    const acct = await createTeam('gh:rj-o');
    await seedApp('rj-app', 'gh:rj-o');
    await DB.prepare('UPDATE apps SET owner_account_id = ? WHERE id = ?').bind(acct, 'rj-app').run();
    await addMember(acct, 'gh:rj-o', 'gh:rj-m', 'guest');
    await DB.prepare("INSERT INTO app_access_grants (id, app_id, account_id, user_id, role, membership_generation, granted_by, created_at, updated_at) VALUES ('rj-g', 'rj-app', ?, 'gh:rj-m', 'app_admin', 1, 'gh:rj-o', 1, 1)").bind(acct).run();
    const can = async () => (await authorize(DB, { userId: asUserId('gh:rj-m'), credential: 'first_party_session' }, { kind: 'app', appId: asAppId('rj-app') }, 'app.source.write')).allowed;
    expect(await can()).toBe(true);
    await del('gh:rj-o', `/accounts/${acct}/members/gh:rj-m`);
    expect(await can()).toBe(false);
    await addMember(acct, 'gh:rj-o', 'gh:rj-m', 'guest');
    expect(await can()).toBe(false);
    await DB.prepare("UPDATE app_access_grants SET revoked_at = NULL WHERE id = 'rj-g'").run(); // a stale row coming back
    expect(await can()).toBe(false); // generation 1 grant vs generation 2 membership
  });

  it('every removal bumps the versions a cached decision is keyed on', async () => {
    const acct = await createTeam('gh:vb-o');
    await seedApp('vb-app', 'gh:vb-o');
    await DB.prepare('UPDATE apps SET owner_account_id = ? WHERE id = ?').bind(acct, 'vb-app').run();
    await addMember(acct, 'gh:vb-o', 'gh:vb-m', 'member');
    const v0 = await rows<{ a: number; x: number }>('SELECT (SELECT authz_version FROM accounts WHERE id = ?1) AS a, (SELECT access_version FROM apps WHERE id = ?2) AS x', acct, 'vb-app');
    await del('gh:vb-o', `/accounts/${acct}/members/gh:vb-m`);
    const v1 = await rows<{ a: number; x: number }>('SELECT (SELECT authz_version FROM accounts WHERE id = ?1) AS a, (SELECT access_version FROM apps WHERE id = ?2) AS x', acct, 'vb-app');
    expect(v1[0]!.a).toBe(v0[0]!.a + 1);
    expect(v1[0]!.x).toBe(v0[0]!.x + 1);
    // a mutation planned against the old version is refused
    const stale = await call('gh:vb-o', 'POST', `/accounts/${acct}/invitations`, { role: 'guest', user_id: 'gh:vb-m', expected_authz_version: v0[0]!.a }, { headers: { 'idempotency-key': key() } });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe('stale_state');
  });
});

describe('personal-account backfill compatibility (shadow mode over a fixture)', () => {
  const ROLES: TeamRole[] = ['viewer', 'po', 'developer', 'admin', 'owner'];

  async function legacyAllows(uid: string, appId: string, min: TeamRole, admin = false): Promise<boolean> {
    const t = await mintSession({ uid, login: uid, avatarUrl: null, roles: admin ? ['user', 'admin'] : ['user', 'creator'] }, base.SESSION_SIGNING_KEY);
    const c = { req: { header: (n: string) => (n.toLowerCase() === 'authorization' ? `Bearer ${t}` : undefined) }, env: base };
    try { await requireAppAccess(c as never, appId, min); return true; } catch { return false; }
  }

  it('every user x minimum role decides the same as before the backfill, with no unexplained expansion', async () => {
    const users = ['gh:sh-owner', 'gh:sh-admin', 'gh:sh-dev', 'gh:sh-po', 'gh:sh-view', 'gh:sh-coowner', 'gh:sh-stranger', 'gh:sh-platform'];
    for (const u of users) await seedUser(u);
    await seedApp('sh-app', 'gh:sh-owner'); await seedApp('sh-other', 'gh:sh-owner');
    const tm = (u: string, r: string) => DB.prepare("INSERT INTO team_members (app_id, user_id, role, created_at) VALUES ('sh-app', ?, ?, 1)").bind(u, r).run();
    await tm('gh:sh-admin', 'admin'); await tm('gh:sh-dev', 'developer'); await tm('gh:sh-po', 'po'); await tm('gh:sh-view', 'viewer'); await tm('gh:sh-coowner', 'owner');

    const report = await runPersonalBackfill(DB, { dryRun: false, runId: 'shadow' });
    expect(report.exceptions).toEqual([]);
    expect(await rows("SELECT id FROM apps WHERE owner_account_id IS NULL AND id IN ('sh-app','sh-other')")).toEqual([]);

    const divergences: string[] = [];
    for (const appId of ['sh-app', 'sh-other']) {
      for (const u of users) {
        for (const min of ROLES) {
          const platformAdmin = u === 'gh:sh-platform';
          const legacy = await legacyAllows(u, appId, min, platformAdmin);
          const decision = await authorize(DB, { userId: asUserId(u), credential: 'first_party_session', platformAdmin }, { kind: 'app', appId: asAppId(appId) }, LEGACY_MIN_ROLE_PERMISSION[min]!);
          const klass = classifyDivergence(legacy, decision);
          if (klass !== 'match') divergences.push(`${appId} ${u} ${min}: ${klass} (${decision.allowed ? 'allow' : decision.reason})`);
        }
      }
    }
    expect(divergences).toEqual([]);
  });

  it('keeps users, apps and team rows exactly as they were', async () => {
    await seedUser('gh:pk-o'); await seedUser('gh:pk-m');
    await seedApp('pk-app', 'gh:pk-o');
    await DB.prepare("INSERT INTO team_members (app_id, user_id, role, created_at) VALUES ('pk-app', 'gh:pk-m', 'developer', 1)").run();
    const before = { u: await rows('SELECT * FROM users ORDER BY id'), t: await rows('SELECT * FROM team_members'), a: await rows('SELECT id, creator_id FROM apps') };
    await runPersonalBackfill(DB, { dryRun: false, runId: 'keep' });
    expect({ u: await rows('SELECT * FROM users ORDER BY id'), t: await rows('SELECT * FROM team_members'), a: await rows('SELECT id, creator_id FROM apps') }).toEqual(before);
    expect(await rows("SELECT role, reason FROM app_access_grants")).toEqual([{ role: 'app_legacy_developer', reason: 'legacy_developer_data_access' }]);
  });

  it('two backfill runs at once create one personal account per user', async () => {
    await seedUser('gh:cc-o');
    await seedApp('cc-app', 'gh:cc-o');
    await Promise.all([runPersonalBackfill(DB, { dryRun: false, runId: 'c1' }), runPersonalBackfill(DB, { dryRun: false, runId: 'c2' })]);
    expect(await rows("SELECT id FROM accounts WHERE personal_user_id = 'gh:cc-o'")).toHaveLength(1);
    expect(await rows("SELECT role FROM account_memberships WHERE user_id = 'gh:cc-o'")).toEqual([{ role: 'owner' }]);
  });
});
