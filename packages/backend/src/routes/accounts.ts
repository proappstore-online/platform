/**
 * Team accounts: creation, membership and targeted invitations (#534 T04, ADR-013).
 *
 * Every route is OFF unless its deployment flag is '1' (ACCOUNTS_READ for reads, ACCOUNTS_WRITE for
 * writes, which implies reads): "Team/account writes remain disabled by default until T05". A
 * disabled route answers 404 `accounts_disabled`, indistinguishable from an unknown path.
 *
 * Authority comes from the verified session, never from the body. Governance needs a first-party
 * session — `caller()` derives its `Principal` from the session's verified credential context
 * (`lib/auth.ts`'s `principalFor`, #535), never from the absence of a `via` claim. A personal app
 * token (`pas_at_…`) is not a session JWT and cannot reach `requireUser` at all. Each mutation is one
 * guarded batch (lib/accounts/operations.ts): authority and version
 * conditions live in the write's own WHERE clause, so a concurrent removal or demotion cannot
 * be raced past a precheck. Invitation secrets are hashed, shown once to the inviter, and never
 * logged, audited or stored in a receipt. No email is sent from this milestone.
 */
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from '../types.js';
import { HttpError, principalFor, requireRecentAuth, requireUser, type FasUser } from '../lib/auth.js';
import {
  INVITABLE_ROLES, MANAGEABLE_TARGET_ROLES, asAccountId, isAccountRole,
  type AccountRole, type Permission,
} from '../lib/accounts/contract.js';
import { authorize, type Decision, type Principal } from '../lib/accounts/authorize.js';
import {
  OP_EXISTS, auditStatement, canonicalJson, commitOperation, newId, newSecret, outboxStatement, sha256Hex,
  type OperationOutcome,
} from '../lib/accounts/operations.js';

export const accountRoutes = new Hono<{ Bindings: Env }>();

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PENDING_INVITATIONS = 50;
const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const ADMIN_INVITABLE_SQL = "('billing_manager','member','guest')";

const on = (v: string | undefined): boolean => v === '1' || v === 'true';

function fail(c: Context<{ Bindings: Env }>, status: number, code: string, extra: Record<string, unknown> = {}): Response {
  c.header('Cache-Control', 'no-store');
  return c.json({ error: { code, ...extra }, request_id: crypto.randomUUID() }, status as ContentfulStatusCode);
}

function ok(c: Context<{ Bindings: Env }>, body: Record<string, unknown>, status = 200): Response {
  c.header('Cache-Control', 'no-store');
  return c.json(body, status as ContentfulStatusCode);
}

/** Wrap a handler: flag gate, then HttpError (session/step-up refusals) as the JSON error shape. */
function route(write: boolean, handler: (c: Context<{ Bindings: Env }>) => Promise<Response>) {
  return async (c: Context<{ Bindings: Env }>): Promise<Response> => {
    const enabled = write ? on(c.env.ACCOUNTS_WRITE) : on(c.env.ACCOUNTS_READ) || on(c.env.ACCOUNTS_WRITE);
    if (!enabled) return fail(c, 404, 'accounts_disabled');
    try {
      return await handler(c);
    } catch (e) {
      if (e instanceof HttpError) return fail(c, e.status, e.status === 401 ? 'unauthenticated' : e.message, e.body ?? {});
      throw e;
    }
  };
}

interface Caller { user: FasUser; principal: Principal }

async function caller(c: Context<{ Bindings: Env }>): Promise<Caller> {
  const user = await requireUser(c);
  return { user, principal: principalFor(user) };
}

async function body(c: Context<{ Bindings: Env }>): Promise<Record<string, unknown>> {
  const b: unknown = await c.req.json().catch(() => null);
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError('invalid_body', 400);
  return b as Record<string, unknown>;
}

function idemKey(c: Context<{ Bindings: Env }>, required: boolean): string {
  const k = c.req.header('Idempotency-Key');
  if (k === undefined || k === '') {
    if (required) throw new HttpError('idempotency_key_required', 400);
    return `auto:${crypto.randomUUID()}`;
  }
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(k)) throw new HttpError('invalid_idempotency_key', 400);
  return k;
}

/** The refusal for a denied decision. Inaccessible accounts are not enumerable: they read as 404. */
function deny(c: Context<{ Bindings: Env }>, d: Extract<Decision, { allowed: false }>): Response {
  switch (d.reason) {
    case 'not_found': case 'not_a_member': case 'membership_removed': case 'no_owner_account':
      return fail(c, 404, 'account_not_found');
    case 'account_suspended': case 'account_not_active': return fail(c, 403, d.reason);
    case 'stale_state': return fail(c, 409, 'stale_state');
    default: return fail(c, 403, d.reason);
  }
}

/** Map a batch outcome to a response. `ok` renders a committed or replayed result. */
function outcome<R extends object>(c: Context<{ Bindings: Env }>, o: OperationOutcome<R>, render: (r: R, replay: boolean) => Response, staleExplain?: () => Promise<Response | null>): Promise<Response> | Response {
  switch (o.kind) {
    case 'committed': return render(o.result, false);
    case 'replay': c.header('Idempotent-Replay', 'true'); return render(o.result, true);
    case 'conflict': return fail(c, 409, 'idempotency_conflict');
    case 'stale': return (async () => (await staleExplain?.()) ?? fail(c, 409, 'stale_state'))();
    case 'error':
      if (o.code === 'last_owner' || o.code === 'account_needs_owner') return fail(c, 409, o.code);
      if (o.code === 'slug_taken' || o.code === 'invitation_exists') return fail(c, 409, o.code);
      return fail(c, 500, 'internal');
  }
}

/** A path parameter; absent means the route did not match, so it is a 404. */
function param(c: Context<{ Bindings: Env }>, name: string): string {
  const v = c.req.param(name);
  if (!v) throw new HttpError('not_found', 404);
  return v;
}

function expectedVersion(b: Record<string, unknown>): number | null {
  const v = b.expected_authz_version;
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new HttpError('invalid_expected_authz_version', 400);
  return v;
}

function check(c: Context<{ Bindings: Env }>, who: Caller, accountId: string, perm: Permission, expectAuthz: number | null): Promise<Decision> {
  return authorize(c.env.DB, who.principal, { kind: 'account', accountId: asAccountId(accountId) }, perm, expectAuthz === null ? {} : { authzVersion: expectAuthz });
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

accountRoutes.get('/me/accounts', route(false, async (c) => {
  const { user } = await caller(c);
  const { results } = await c.env.DB.prepare(
    `SELECT ac.id, ac.kind, ac.name, ac.slug, ac.status, ac.authz_version, m.role
       FROM account_memberships m JOIN accounts ac ON ac.id = m.account_id
      WHERE m.user_id = ?1 AND m.status = 'active' AND ac.status IN ('active','suspended')
      ORDER BY ac.kind, ac.name LIMIT 100`,
  ).bind(user.id).all();
  return ok(c, { accounts: results ?? [] });
}));

function deriveSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');
}

accountRoutes.post('/accounts', route(true, async (c) => {
  const who = await caller(c);
  if (who.principal.credential !== 'first_party_session') return fail(c, 403, 'credential_scope');
  const b = await body(c);
  const key = idemKey(c, true);
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (name.length < 1 || name.length > 80) return fail(c, 400, 'invalid_name');
  const slug = typeof b.slug === 'string' ? b.slug.trim().toLowerCase() : deriveSlug(name);
  if (!SLUG.test(slug) || slug.startsWith('p-')) return fail(c, 400, 'invalid_slug');

  // A team owner is a human with a PAS login: app-bound credential accounts never become owners.
  const row = await c.env.DB.prepare('SELECT credential_app_id FROM users WHERE id = ?').bind(who.user.id).first<{ credential_app_id: string | null }>();
  if (!row || row.credential_app_id !== null) return fail(c, 403, 'team_owner_not_permitted');

  const now = Date.now();
  const accountId = newId('acct');
  const opId = newId('op');
  const db = c.env.DB;
  const result = { account: { id: accountId, kind: 'team', name, slug, status: 'active', role: 'owner' } };
  const o = await commitOperation(db, {
    id: opId, actorId: who.user.id, accountId, action: 'account.create', key, payloadHash: await sha256Hex(canonicalJson({ name, slug })), result, now,
  },
  db.prepare(`INSERT INTO accounts (id, kind, name, slug, status, created_by, created_at, updated_at) VALUES (?1, 'team', ?2, ?3, 'provisioning', ?4, ?5, ?5)`)
    .bind(accountId, name, slug, who.user.id, now),
  [
    db.prepare(`INSERT INTO account_memberships (account_id, user_id, role, status, generation, created_by, created_at, updated_at)
                SELECT ?1, ?2, 'owner', 'active', 1, ?2, ?3, ?3 WHERE EXISTS ${OP_EXISTS.replace('?', '?4')}`).bind(accountId, who.user.id, now, opId),
    db.prepare(`UPDATE accounts SET status = 'active', authz_version = authz_version + 1, updated_at = ?2 WHERE id = ?1 AND EXISTS ${OP_EXISTS.replace('?', '?3')}`).bind(accountId, now, opId),
    auditStatement(db, { opId, accountId, actorId: who.user.id, credential: who.principal.credential, action: 'account.create', targetType: 'account', targetId: accountId, authzVersionSql: '(SELECT authz_version FROM accounts WHERE id = ?2)', details: { kind: 'team', slug }, now }),
  ]);
  return outcome(c, o, (r, replay) => ok(c, r, replay ? 200 : 201));
}));

accountRoutes.get('/accounts/:id', route(false, async (c) => {
  const who = await caller(c);
  const d = await check(c, who, param(c, 'id'), 'account.read', null);
  if (!d.allowed) return deny(c, d);
  const a = await c.env.DB.prepare('SELECT id, kind, name, slug, status, authz_version FROM accounts WHERE id = ?').bind(d.accountId).first();
  return ok(c, { account: { ...a, role: d.role } });
}));

accountRoutes.get('/accounts/:id/members', route(false, async (c) => {
  const who = await caller(c);
  const d = await check(c, who, param(c, 'id'), 'account.members.read', null);
  if (!d.allowed) return deny(c, d);
  const { results } = await c.env.DB.prepare(
    `SELECT user_id, role, generation, created_at FROM account_memberships WHERE account_id = ?1 AND status = 'active' ORDER BY created_at, user_id LIMIT 500`,
  ).bind(d.accountId).all();
  return ok(c, { account_id: d.accountId, authz_version: d.versions.authz, members: results ?? [] });
}));

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

/** SQL fragment: the caller (?param) is the invitation's intended recipient. Exact match only; no alias normalization. */
const RECIPIENT = (user: string) => `(i.target_user_id = ${user} OR (i.target_email IS NOT NULL AND i.target_email IN (SELECT email FROM user_verified_emails WHERE user_id = ${user} AND revoked_at IS NULL)))`;

accountRoutes.post('/accounts/:id/invitations', route(true, async (c) => {
  const who = await caller(c);
  const accountId = param(c, 'id');
  const b = await body(c);
  const key = idemKey(c, true);
  const exp = expectedVersion(b);
  if (!isAccountRole(b.role)) return fail(c, 400, 'invalid_role');
  const role: AccountRole = b.role;
  const targetUser = typeof b.user_id === 'string' ? b.user_id.trim() : null;
  const targetEmail = typeof b.email === 'string' ? b.email.trim().toLowerCase() : null;
  if ((targetUser === null) === (targetEmail === null)) return fail(c, 400, 'exactly_one_target');
  if (targetUser !== null && (targetUser.length > 200 || !targetUser.includes(':'))) return fail(c, 400, 'invalid_target');
  if (targetEmail !== null && (targetEmail.length > 254 || !EMAIL.test(targetEmail))) return fail(c, 400, 'invalid_target');
  if (targetUser === who.user.id) return fail(c, 400, 'cannot_invite_self');

  const d = await check(c, who, accountId, 'account.members.invite', exp);
  if (!d.allowed) return deny(c, d);
  if (!(INVITABLE_ROLES[d.role as AccountRole] ?? []).includes(role)) return fail(c, 403, 'permission_missing', { detail: 'role_ceiling' });

  const db = c.env.DB;
  if (targetUser !== null) {
    const member = await db.prepare(`SELECT 1 FROM account_memberships WHERE account_id = ?1 AND user_id = ?2 AND status = 'active'`).bind(accountId, targetUser).first();
    if (member) return fail(c, 409, 'already_member');
  }
  const pending = await db.prepare(`SELECT COUNT(*) AS n FROM account_invitations WHERE account_id = ?1 AND status = 'pending' AND expires_at > ?2`).bind(accountId, Date.now()).first<{ n: number }>();
  if ((pending?.n ?? 0) >= MAX_PENDING_INVITATIONS) return fail(c, 429, 'too_many_pending_invitations');

  const now = Date.now();
  const id = newId('inv');
  const opId = newId('op');
  const secret = newSecret();
  const tokenHash = await sha256Hex(secret);
  const expiresAt = now + INVITATION_TTL_MS;
  const target = targetUser !== null ? { type: 'user', value: targetUser } : { type: 'email', value: targetEmail };
  const result = { invitation: { id, account_id: accountId, role, target, status: 'pending', expires_at: expiresAt } };
  const o = await commitOperation(db, {
    id: opId, actorId: who.user.id, accountId, action: 'invitation.create', key,
    payloadHash: await sha256Hex(canonicalJson({ accountId, role, target })), result, now,
  },
  // The guard: the inviter must still be an active owner/admin whose role ceiling covers the role, in an active account at the expected version.
  db.prepare(
    `INSERT INTO account_invitations (id, account_id, target_user_id, target_email, role, inviter_id, inviter_generation, token_hash, status, version, expires_at, created_at, updated_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, im.generation, ?7, 'pending', 0, ?8, ?9, ?9
       FROM account_memberships im JOIN accounts ac ON ac.id = im.account_id
      WHERE im.account_id = ?2 AND im.user_id = ?6 AND im.status = 'active' AND ac.status = 'active'
        AND (im.role = 'owner' OR (im.role = 'admin' AND ?5 IN ${ADMIN_INVITABLE_SQL}))
        AND ac.authz_version = COALESCE(?10, ac.authz_version)`,
  ).bind(id, accountId, targetUser, targetEmail, role, who.user.id, tokenHash, expiresAt, now, exp),
  [
    outboxStatement(db, { opId, effect: 'invitation_notice', accountId, payload: { invitation_id: id }, state: 'held', now }),
    auditStatement(db, { opId, accountId, actorId: who.user.id, credential: who.principal.credential, action: 'invitation.create', targetType: 'invitation', targetId: id, authzVersionSql: '(SELECT authz_version FROM accounts WHERE id = ?2)', details: { role, target_type: target.type }, now }),
  ],
  // A lapsed pending invitation for the same recipient must not block a fresh one (unique pending-target index).
  [db.prepare(`UPDATE account_invitations SET status = 'expired', updated_at = ?3 WHERE account_id = ?1 AND status = 'pending' AND expires_at <= ?3 AND COALESCE(target_user_id, target_email) = ?2`).bind(accountId, targetUser ?? targetEmail, now)]);
  return outcome(c, o, (r, replay) => ok(c, { ...r, invitation_secret: replay ? null : secret, secret_shown_once: true }, replay ? 200 : 201));
}));

accountRoutes.post('/invitations/:id/preview', route(false, async (c) => {
  const who = await caller(c);
  const b = await body(c);
  if (typeof b.secret !== 'string' || b.secret.length < 20 || b.secret.length > 200) return fail(c, 404, 'invitation_not_found');
  const row = await c.env.DB.prepare(
    `SELECT i.id, i.role, i.inviter_id, i.expires_at, ac.id AS account_id, ac.name AS account_name
       FROM account_invitations i JOIN accounts ac ON ac.id = i.account_id
      WHERE i.id = ?1 AND i.token_hash = ?2 AND i.status = 'pending' AND i.expires_at > ?4 AND ac.status = 'active' AND ${RECIPIENT('?3')}`,
  ).bind(param(c, 'id'), await sha256Hex(b.secret), who.user.id, Date.now()).first<{ id: string; role: string; inviter_id: string; expires_at: number; account_id: string; account_name: string }>();
  // The same answer for a wrong secret, a wrong recipient, a used or an expired invitation: nothing to enumerate.
  if (!row) return fail(c, 404, 'invitation_not_found');
  return ok(c, { invitation: { id: row.id, role: row.role, expires_at: row.expires_at, inviter_id: row.inviter_id, account: { id: row.account_id, name: row.account_name } }, you: who.user.id });
}));

accountRoutes.post('/invitations/:id/accept', route(true, async (c) => {
  const who = await caller(c);
  if (who.principal.credential !== 'first_party_session') return fail(c, 403, 'credential_scope');
  const invId = param(c, 'id');
  const b = await body(c);
  if (typeof b.secret !== 'string' || b.secret.length < 20 || b.secret.length > 200) return fail(c, 404, 'invitation_not_found');
  const db = c.env.DB;
  const tokenHash = await sha256Hex(b.secret);
  const row = await db.prepare(
    `SELECT i.account_id, i.role FROM account_invitations i WHERE i.id = ?1 AND i.token_hash = ?2 AND ${RECIPIENT('?3')}`,
  ).bind(invId, tokenHash, who.user.id).first<{ account_id: string; role: string }>();
  if (!row) return fail(c, 404, 'invitation_not_found');

  const now = Date.now();
  const opId = newId('op');
  const result = { account: { id: row.account_id, role: row.role } };
  const o = await commitOperation(db, {
    // The natural key makes a repeated accept by the same person a replay, never a second claim.
    id: opId, actorId: who.user.id, accountId: row.account_id, action: 'invitation.accept', key: `accept:${invId}`, payloadHash: await sha256Hex(invId), result, now,
  },
  // The claim: single winner; recipient-bound; unexpired; account active; the inviter's authority still holds; not already a member.
  db.prepare(
    `UPDATE account_invitations AS i SET status = 'accepted', accepted_by = ?3, accepted_at = ?4, version = i.version + 1, updated_at = ?4
      WHERE i.id = ?1 AND i.token_hash = ?2 AND i.status = 'pending' AND i.expires_at > ?4 AND ${RECIPIENT('?3')}
        AND EXISTS (SELECT 1 FROM accounts ac WHERE ac.id = i.account_id AND ac.status = 'active')
        AND NOT EXISTS (SELECT 1 FROM account_memberships e WHERE e.account_id = i.account_id AND e.user_id = ?3 AND e.status = 'active')
        AND EXISTS (SELECT 1 FROM account_memberships im WHERE im.account_id = i.account_id AND im.user_id = i.inviter_id AND im.status = 'active'
                      AND im.generation = i.inviter_generation AND (im.role = 'owner' OR (im.role = 'admin' AND i.role IN ${ADMIN_INVITABLE_SQL})))`,
  ).bind(invId, tokenHash, who.user.id, now),
  [
    // Rejoin bumps the generation, so grants of an earlier stint never match again.
    db.prepare(
      `INSERT INTO account_memberships (account_id, user_id, role, status, generation, created_by, created_at, updated_at)
       SELECT i.account_id, ?2, i.role, 'active', 1, i.inviter_id, ?3, ?3 FROM account_invitations i
        WHERE i.id = ?1 AND i.accepted_by = ?2 AND EXISTS ${OP_EXISTS.replace('?', '?4')}
       ON CONFLICT (account_id, user_id) DO UPDATE SET role = excluded.role, status = 'active', generation = account_memberships.generation + 1,
         created_by = excluded.created_by, updated_at = excluded.updated_at WHERE account_memberships.status = 'removed'`,
    ).bind(invId, who.user.id, now, opId),
    db.prepare(`UPDATE accounts SET authz_version = authz_version + 1, updated_at = ?2 WHERE id = ?1 AND EXISTS ${OP_EXISTS.replace('?', '?3')}`).bind(row.account_id, now, opId),
    db.prepare(`UPDATE apps SET access_version = access_version + 1 WHERE owner_account_id = ?1 AND EXISTS ${OP_EXISTS.replace('?', '?2')}`).bind(row.account_id, opId),
    auditStatement(db, { opId, accountId: row.account_id, actorId: who.user.id, credential: who.principal.credential, action: 'invitation.accept', targetType: 'invitation', targetId: invId, authzVersionSql: '(SELECT authz_version FROM accounts WHERE id = ?2)', details: { role: row.role }, now }),
  ]);
  return outcome(c, o, (r) => ok(c, r), async () => {
    // Explain a refused claim (a non-authoritative re-read; the claim above was the decision).
    const s = await db.prepare(
      `SELECT i.status, i.expires_at, ac.status AS account_status,
              EXISTS (SELECT 1 FROM account_memberships e WHERE e.account_id = i.account_id AND e.user_id = ?3 AND e.status = 'active') AS member
         FROM account_invitations i JOIN accounts ac ON ac.id = i.account_id WHERE i.id = ?1 AND i.token_hash = ?2 AND ${RECIPIENT('?3')}`,
    ).bind(invId, tokenHash, who.user.id).first<{ status: string; expires_at: number; account_status: string; member: number }>();
    if (!s) return fail(c, 404, 'invitation_not_found');
    if (s.status === 'revoked') return fail(c, 409, 'invitation_revoked');
    if (s.status !== 'pending') return fail(c, 409, 'invitation_not_pending');
    if (s.expires_at <= Date.now()) return fail(c, 410, 'invitation_expired');
    if (s.account_status !== 'active') return fail(c, 403, 'account_not_active');
    if (s.member) return fail(c, 409, 'already_member');
    return fail(c, 403, 'inviter_no_longer_authorized');
  });
}));

accountRoutes.post('/accounts/:id/invitations/:iid/revoke', route(true, async (c) => {
  const who = await caller(c);
  const accountId = param(c, 'id');
  const iid = param(c, 'iid');
  const b = await body(c).catch(() => ({} as Record<string, unknown>));
  const key = idemKey(c, false);
  const d = await check(c, who, accountId, 'account.members.invite', expectedVersion(b));
  if (!d.allowed) return deny(c, d);
  const db = c.env.DB;
  const inv = await db.prepare(`SELECT role FROM account_invitations WHERE id = ?1 AND account_id = ?2`).bind(iid, accountId).first<{ role: string }>();
  if (!inv) return fail(c, 404, 'invitation_not_found');
  const now = Date.now();
  const opId = newId('op');
  const o = await commitOperation(db, {
    id: opId, actorId: who.user.id, accountId, action: 'invitation.revoke', key, payloadHash: await sha256Hex(canonicalJson({ accountId, iid })), result: { invitation: { id: iid, status: 'revoked' } }, now,
  },
  db.prepare(
    `UPDATE account_invitations AS i SET status = 'revoked', version = i.version + 1, updated_at = ?4
      WHERE i.id = ?1 AND i.account_id = ?2 AND i.status = 'pending'
        AND EXISTS (SELECT 1 FROM account_memberships a JOIN accounts ac ON ac.id = a.account_id
                     WHERE a.account_id = ?2 AND a.user_id = ?3 AND a.status = 'active' AND ac.status = 'active'
                       AND (a.role = 'owner' OR (a.role = 'admin' AND i.role IN ${ADMIN_INVITABLE_SQL})))`,
  ).bind(iid, accountId, who.user.id, now),
  [auditStatement(db, { opId, accountId, actorId: who.user.id, credential: who.principal.credential, action: 'invitation.revoke', targetType: 'invitation', targetId: iid, authzVersionSql: '(SELECT authz_version FROM accounts WHERE id = ?2)', now })]);
  return outcome(c, o, (r) => ok(c, r), async () => {
    const s = await db.prepare(`SELECT status FROM account_invitations WHERE id = ?1`).bind(iid).first<{ status: string }>();
    return s && s.status !== 'pending' ? fail(c, 409, 'invitation_not_pending') : fail(c, 403, 'permission_missing');
  });
}));

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

/** SQL: the actor (?param) is an active member of an active account, with the version condition. */
const ACTOR_OK = (acct: string, actor: string, exp: string, roleRule: string) =>
  `EXISTS (SELECT 1 FROM account_memberships a JOIN accounts ac ON ac.id = a.account_id
            WHERE a.account_id = ${acct} AND a.user_id = ${actor} AND a.status = 'active' AND ac.status = 'active'
              AND ac.authz_version = COALESCE(${exp}, ac.authz_version) AND (${roleRule}))`;

accountRoutes.patch('/accounts/:id/members/:uid', route(true, async (c) => {
  const who = await caller(c);
  const accountId = param(c, 'id');
  const targetId = param(c, 'uid');
  const b = await body(c);
  const key = idemKey(c, false);
  const exp = expectedVersion(b);
  if (!isAccountRole(b.role)) return fail(c, 400, 'invalid_role');
  const newRole: AccountRole = b.role;
  const promoting = newRole === 'owner';

  const d = await check(c, who, accountId, promoting ? 'account.owner.promote' : 'account.members.manage', exp);
  if (!d.allowed) return deny(c, d);
  if (promoting) requireRecentAuth(who.user, c.env); // only owners reach here, with recent authentication

  const db = c.env.DB;
  const cur = await db.prepare(`SELECT role FROM account_memberships WHERE account_id = ?1 AND user_id = ?2 AND status = 'active'`).bind(accountId, targetId).first<{ role: string }>();
  if (!cur) return fail(c, 404, 'member_not_found');
  const actorRole = d.role as AccountRole;
  const manageable = MANAGEABLE_TARGET_ROLES[actorRole] ?? [];
  if (!isAccountRole(cur.role) || !manageable.includes(cur.role) || (!promoting && !manageable.includes(newRole))) return fail(c, 403, 'permission_missing', { detail: 'role_ceiling' });
  if (cur.role === newRole) return fail(c, 409, 'role_unchanged');

  const now = Date.now();
  const opId = newId('op');
  const o = await commitOperation(db, {
    id: opId, actorId: who.user.id, accountId, action: 'member.role', key, payloadHash: await sha256Hex(canonicalJson({ accountId, targetId, newRole })),
    result: { member: { account_id: accountId, user_id: targetId, role: newRole } }, now,
  },
  db.prepare(
    `UPDATE account_memberships SET role = ?4, updated_at = ?6
      WHERE account_id = ?1 AND user_id = ?2 AND status = 'active' AND role = ?3
        AND ${ACTOR_OK('?1', '?5', '?7', `a.role = 'owner' OR (a.role = 'admin' AND ?3 IN ${ADMIN_INVITABLE_SQL} AND ?4 IN ${ADMIN_INVITABLE_SQL})`)}
        AND (?4 <> 'owner' OR EXISTS (SELECT 1 FROM users u WHERE u.id = ?2 AND u.credential_app_id IS NULL))`,
  ).bind(accountId, targetId, cur.role, newRole, who.user.id, now, exp),
  [
    db.prepare(`UPDATE accounts SET authz_version = authz_version + 1, updated_at = ?2 WHERE id = ?1 AND EXISTS ${OP_EXISTS.replace('?', '?3')}`).bind(accountId, now, opId),
    db.prepare(`UPDATE apps SET access_version = access_version + 1 WHERE owner_account_id = ?1 AND EXISTS ${OP_EXISTS.replace('?', '?2')}`).bind(accountId, opId),
    auditStatement(db, { opId, accountId, actorId: who.user.id, credential: who.principal.credential, action: 'member.role', targetType: 'user', targetId, authzVersionSql: '(SELECT authz_version FROM accounts WHERE id = ?2)', details: { from: cur.role, to: newRole }, now }),
  ]);
  return outcome(c, o, (r) => ok(c, r));
}));

accountRoutes.delete('/accounts/:id/members/:uid', route(true, async (c) => {
  const who = await caller(c);
  const accountId = param(c, 'id');
  const targetId = param(c, 'uid');
  const b = await body(c).catch(() => ({} as Record<string, unknown>));
  const key = idemKey(c, false);
  const exp = expectedVersion(b);
  const self = targetId === who.user.id;

  // Anyone active may leave (a guest holds no permission, so no permission is asked; the guard below
  // still requires an active member of an active account). Removing someone else is governance.
  let actorRole: string | null = null;
  if (!self) {
    const d = await check(c, who, accountId, 'account.members.manage', exp);
    if (!d.allowed) return deny(c, d);
    actorRole = d.role;
  }

  const db = c.env.DB;
  const cur = await db.prepare(`SELECT role FROM account_memberships WHERE account_id = ?1 AND user_id = ?2 AND status = 'active'`).bind(accountId, targetId).first<{ role: string }>();
  if (!cur) return fail(c, 404, 'member_not_found');
  if (!self && (!isAccountRole(cur.role) || !(MANAGEABLE_TARGET_ROLES[actorRole as AccountRole] ?? []).includes(cur.role))) return fail(c, 403, 'permission_missing', { detail: 'role_ceiling' });

  const now = Date.now();
  const opId = newId('op');
  const o = await commitOperation(db, {
    id: opId, actorId: who.user.id, accountId, action: 'member.remove', key, payloadHash: await sha256Hex(canonicalJson({ accountId, targetId })),
    result: { removed: { account_id: accountId, user_id: targetId } }, now,
  },
  db.prepare(
    `UPDATE account_memberships SET status = 'removed', updated_at = ?5
      WHERE account_id = ?1 AND user_id = ?2 AND status = 'active' AND role = ?3
        AND ${ACTOR_OK('?1', '?4', '?6', `?4 = ?2 OR a.role = 'owner' OR (a.role = 'admin' AND ?3 IN ${ADMIN_INVITABLE_SQL})`)}`,
  ).bind(accountId, targetId, cur.role, who.user.id, now, exp),
  [
    // Authority of the removed member ends here, in the same transaction: grants, the invitations they issued, and every cached decision (versions).
    db.prepare(`UPDATE app_access_grants SET revoked_at = ?3, updated_at = ?3 WHERE account_id = ?1 AND user_id = ?2 AND revoked_at IS NULL AND EXISTS ${OP_EXISTS.replace('?', '?4')}`).bind(accountId, targetId, now, opId),
    db.prepare(`UPDATE account_invitations SET status = 'revoked', version = version + 1, updated_at = ?3 WHERE account_id = ?1 AND inviter_id = ?2 AND status = 'pending' AND EXISTS ${OP_EXISTS.replace('?', '?4')}`).bind(accountId, targetId, now, opId),
    db.prepare(`UPDATE accounts SET authz_version = authz_version + 1, updated_at = ?2 WHERE id = ?1 AND EXISTS ${OP_EXISTS.replace('?', '?3')}`).bind(accountId, now, opId),
    db.prepare(`UPDATE apps SET access_version = access_version + 1 WHERE owner_account_id = ?1 AND EXISTS ${OP_EXISTS.replace('?', '?2')}`).bind(accountId, opId),
    // GitHub collaborators, ProjectDO projections and provider grants are reconciled by T05; recorded now so the work is not lost.
    outboxStatement(db, { opId, effect: 'access_reconcile', accountId, payload: { user_id: targetId }, state: 'held', now }),
    auditStatement(db, { opId, accountId, actorId: who.user.id, credential: who.principal.credential, action: 'member.remove', targetType: 'user', targetId, authzVersionSql: '(SELECT authz_version FROM accounts WHERE id = ?2)', details: { role: cur.role, self }, now }),
  ]);
  return outcome(c, o, (r) => ok(c, r));
}));
