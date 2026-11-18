/**
 * Verified app email (#566): per-app sender domains and identities, and THE
 * server-side send primitive, `sendAppEmail`. The authenticated route, the app
 * worker's `pas.email.send` and (#466) scheduled sending all call it; there is
 * no second send path.
 *
 * Trust rules, all enforced here and never by the caller:
 *  - From is built from the app's stored identity. A caller names an identity
 *    (its id or registered address) and can never supply a From, provider id or
 *    timestamp. An identity that is missing, not approved, revoked, suspended, or
 *    whose domain is not verified refuses with a stable code and ZERO provider
 *    calls. There is no fallback to another sender.
 *  - A domain is proved by the provider's DNS verification (`verifyDomainClaim`).
 *  - A retry with the same idempotency key never sends twice.
 *  - Quotas and the per-app suppression list are checked before the provider is called.
 *
 * `accepted` means the provider took the message, never that it was delivered.
 */
import type { Env } from '../types.js';
import { isLikelyEmail } from './email.js';
import { sha256Hex } from './app-tokens.js';
import * as resend from './resend.js';

export type EmailErrorCode =
  | 'email_not_configured' | 'invalid_request' | 'sender_not_found' | 'sender_not_approved' | 'sender_revoked'
  | 'sender_suspended' | 'sender_domain_unverified' | 'app_suspended' | 'external_recipient_not_allowed'
  | 'recipient_suppressed' | 'quota_app_daily' | 'quota_identity_daily' | 'quota_burst' | 'idempotency_conflict'
  | 'domain_not_claimed' | 'domain_taken' | 'domain_reserved' | 'address_taken' | 'not_found' | 'provider_error';

const STATUS: Record<EmailErrorCode, number> = {
  email_not_configured: 503, invalid_request: 400, sender_not_found: 404, sender_not_approved: 403, sender_revoked: 403,
  sender_suspended: 403, sender_domain_unverified: 403, app_suspended: 403, external_recipient_not_allowed: 403,
  recipient_suppressed: 422, quota_app_daily: 429, quota_identity_daily: 429, quota_burst: 429, idempotency_conflict: 409,
  domain_not_claimed: 400, domain_taken: 409, domain_reserved: 403, address_taken: 409, not_found: 404, provider_error: 502,
};

/** A refusal with a stable `code`. */
export class EmailError extends Error {
  readonly status: number;
  constructor(readonly code: EmailErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.status = STATUS[code];
  }
}

/** Platform defaults; an admin can override per app in email_app_settings. */
export const EMAIL_LIMITS = {
  appDaily: 500,
  identityDaily: 300,
  /** Sends per rolling minute for one app. */
  burst: 30,
  maxRecipients: 10,
  maxSubject: 200,
  maxBodyChars: 200_000,
} as const;

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const IDEM_KEY = /^[A-Za-z0-9._:-]{1,200}$/;
const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/** The platform's own domain: an app cannot claim it. */
const RESERVED_DOMAIN = /(^|\.)proappstore\.online$/;

const normalizeAddress = (a: string): string => a.trim().toLowerCase();
const hasLineBreak = (s: string) => /[\r\n]/.test(s);

const requireKey = (env: Pick<Env, 'RESEND_API_KEY'>): string => {
  if (!env.RESEND_API_KEY) throw new EmailError('email_not_configured', 'verified app email is not configured on this deployment');
  return env.RESEND_API_KEY;
};

// ── domains ─────────────────────────────────────────────────────────────────

export interface EmailDomain {
  id: string; domain: string; status: 'pending' | 'verified' | 'failed'; receiving: boolean;
  records: resend.ResendDnsRecord[]; createdAt: number; verifiedAt: number | null; checkedAt: number | null;
}
interface DomainRow {
  id: string; app_id: string; domain: string; provider_domain_id: string; status: string; receiving: number;
  records: string; created_at: number; verified_at: number | null; checked_at: number | null;
}
const domainOut = (r: DomainRow): EmailDomain => ({
  id: r.id, domain: r.domain, status: r.status as EmailDomain['status'], receiving: r.receiving === 1,
  records: JSON.parse(r.records) as resend.ResendDnsRecord[], createdAt: r.created_at, verifiedAt: r.verified_at, checkedAt: r.checked_at,
});
const providerStatus = (s: string): EmailDomain['status'] => (s === 'verified' ? 'verified' : s === 'failed' ? 'failed' : 'pending');

async function providerCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof resend.ResendError) throw new EmailError('provider_error', `the email provider answered ${e.status || 'no response'}`);
    throw e;
  }
}

/**
 * An app claims a domain to send from. Returns the DNS records the owner must add; the domain
 * is usable only after `verifyDomainClaim` sees the provider confirm them (proof of control).
 * One app per domain: a domain verified by another app is refused; an UNVERIFIED claim by
 * another app is displaced, so squatting a domain you cannot prove blocks nobody.
 */
export async function claimDomain(
  env: Env, appId: string, domainInput: string, opts: { receiving?: boolean; isAdmin?: boolean; now?: number } = {},
): Promise<EmailDomain> {
  const apiKey = requireKey(env);
  const domain = normalizeAddress(domainInput);
  if (!DOMAIN_RE.test(domain)) throw new EmailError('invalid_request', 'domain is not a valid domain name');
  if (RESERVED_DOMAIN.test(domain) && !opts.isAdmin) throw new EmailError('domain_reserved', 'the platform domain cannot be claimed');
  const now = opts.now ?? Date.now();
  const existing = await env.DB.prepare('SELECT * FROM email_domains WHERE domain = ?').bind(domain).first<DomainRow>();
  if (existing) {
    if (existing.app_id === appId) return domainOut(existing);
    if (existing.status === 'verified') throw new EmailError('domain_taken', 'another app has verified this domain');
    await providerCall(() => resend.deleteDomain(apiKey, existing.provider_domain_id)).catch(() => undefined);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM email_identities WHERE app_id = ? AND domain = ?').bind(existing.app_id, domain),
      env.DB.prepare('DELETE FROM email_domains WHERE id = ?').bind(existing.id),
    ]);
  }
  const created = await providerCall(() => resend.createDomain(apiKey, domain, opts.receiving === true));
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO email_domains (id, app_id, domain, provider_domain_id, status, receiving, records, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, appId, domain, created.id, providerStatus(created.status), opts.receiving ? 1 : 0, JSON.stringify(created.records), now).run();
  return domainOut((await env.DB.prepare('SELECT * FROM email_domains WHERE id = ?').bind(id).first<DomainRow>())!);
}

/** Ask the provider to re-check the DNS records and record the result. */
export async function verifyDomainClaim(env: Env, appId: string, domainInput: string, now = Date.now()): Promise<EmailDomain> {
  const apiKey = requireKey(env);
  const row = await env.DB.prepare('SELECT * FROM email_domains WHERE app_id = ? AND domain = ?').bind(appId, normalizeAddress(domainInput)).first<DomainRow>();
  if (!row) throw new EmailError('not_found', 'this app has not claimed that domain');
  const checked = await providerCall(() => resend.verifyDomain(apiKey, row.provider_domain_id));
  const status = providerStatus(checked.status);
  await env.DB.prepare(
    `UPDATE email_domains SET status = ?, records = ?, checked_at = ?, verified_at = CASE WHEN ? = 'verified' THEN COALESCE(verified_at, ?) ELSE NULL END WHERE id = ?`,
  ).bind(status, JSON.stringify(checked.records.length ? checked.records : JSON.parse(row.records)), now, status, now, row.id).run();
  return domainOut((await env.DB.prepare('SELECT * FROM email_domains WHERE id = ?').bind(row.id).first<DomainRow>())!);
}

/** Release a domain: its identities are revoked and the provider domain is deleted. */
export async function removeDomain(env: Env, appId: string, domainInput: string, now = Date.now()): Promise<void> {
  const apiKey = requireKey(env);
  const domain = normalizeAddress(domainInput);
  const row = await env.DB.prepare('SELECT * FROM email_domains WHERE app_id = ? AND domain = ?').bind(appId, domain).first<DomainRow>();
  if (!row) throw new EmailError('not_found', 'this app has not claimed that domain');
  await providerCall(() => resend.deleteDomain(apiKey, row.provider_domain_id));
  await env.DB.batch([
    env.DB.prepare("UPDATE email_identities SET status = 'revoked', revoked_at = ?, revoked_by = 'system:domain-removed' WHERE app_id = ? AND domain = ? AND status != 'revoked'").bind(now, appId, domain),
    env.DB.prepare('DELETE FROM email_domains WHERE id = ?').bind(row.id),
  ]);
}

// ── identities ──────────────────────────────────────────────────────────────

export interface EmailIdentity {
  id: string; address: string; displayName: string | null; replyTo: string | null;
  status: 'pending' | 'approved' | 'revoked'; allowExternal: boolean; suspended: boolean;
  /** Whether the domain is verified: an identity sends only when approved, not suspended and verified. */
  domainVerified: boolean; usable: boolean;
  createdAt: number; approvedAt: number | null; revokedAt: number | null;
}
interface IdentityRow {
  id: string; app_id: string; address: string; domain: string; display_name: string | null; reply_to: string | null; status: string;
  allow_external: number; suspended: number; suspended_reason: string | null; created_at: number; created_by: string;
  approved_at: number | null; approved_by: string | null; revoked_at: number | null; revoked_by: string | null; domain_status?: string | null;
}
const identityOut = (r: IdentityRow): EmailIdentity => ({
  id: r.id, address: r.address, displayName: r.display_name, replyTo: r.reply_to, status: r.status as EmailIdentity['status'],
  allowExternal: r.allow_external === 1, suspended: r.suspended === 1, domainVerified: r.domain_status === 'verified',
  usable: r.status === 'approved' && r.suspended === 0 && r.domain_status === 'verified',
  createdAt: r.created_at, approvedAt: r.approved_at, revokedAt: r.revoked_at,
});
const IDENTITY_SELECT = 'SELECT i.*, d.status AS domain_status FROM email_identities i LEFT JOIN email_domains d ON d.domain = i.domain AND d.app_id = i.app_id';

function cleanDisplayName(name: unknown): string | null {
  if (name === undefined || name === null || name === '') return null;
  if (typeof name !== 'string' || name.length > 80 || hasLineBreak(name) || /[<>"\\]/.test(name)) throw new EmailError('invalid_request', 'displayName must be at most 80 characters without line breaks, quotes or angle brackets');
  return name.trim() || null;
}

/** An app declares a sender address on a domain it has claimed. It starts `pending`: the owner must approve it. */
export async function declareIdentity(
  env: Pick<Env, 'DB'>, appId: string, input: { address: string; displayName?: unknown; replyTo?: unknown }, by: string, now = Date.now(),
): Promise<EmailIdentity> {
  const address = normalizeAddress(String(input.address ?? ''));
  if (!isLikelyEmail(address) || hasLineBreak(address)) throw new EmailError('invalid_request', 'address is not a valid email address');
  const domain = address.slice(address.indexOf('@') + 1);
  const displayName = cleanDisplayName(input.displayName);
  let replyTo: string | null = null;
  if (input.replyTo !== undefined && input.replyTo !== null && input.replyTo !== '') {
    replyTo = normalizeAddress(String(input.replyTo));
    if (!isLikelyEmail(replyTo) || hasLineBreak(replyTo)) throw new EmailError('invalid_request', 'replyTo is not a valid email address');
  }
  const claimed = await env.DB.prepare('SELECT 1 AS ok FROM email_domains WHERE app_id = ? AND domain = ?').bind(appId, domain).first();
  if (!claimed) throw new EmailError('domain_not_claimed', `claim ${domain} first`);
  const existing = await env.DB.prepare('SELECT app_id FROM email_identities WHERE address = ?').bind(address).first<{ app_id: string }>();
  if (existing && existing.app_id !== appId) throw new EmailError('address_taken', 'that address belongs to another app');
  if (existing) {
    await env.DB.prepare('UPDATE email_identities SET display_name = ?, reply_to = ? WHERE address = ?').bind(displayName, replyTo, address).run();
  } else {
    await env.DB.prepare(
      'INSERT INTO email_identities (id, app_id, address, domain, display_name, reply_to, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(crypto.randomUUID(), appId, address, domain, displayName, replyTo, now, by).run();
  }
  return identityOut((await env.DB.prepare(`${IDENTITY_SELECT} WHERE i.address = ?`).bind(address).first<IdentityRow>())!);
}

async function identityById(env: Pick<Env, 'DB'>, appId: string, id: string): Promise<IdentityRow> {
  const row = await env.DB.prepare(`${IDENTITY_SELECT} WHERE i.app_id = ? AND i.id = ?`).bind(appId, id).first<IdentityRow>();
  if (!row) throw new EmailError('sender_not_found', 'no such sender identity for this app');
  return row;
}

/** The owner approves an identity; `allowExternal` is the separate, explicit capability to mail non-members. */
export async function approveIdentity(env: Pick<Env, 'DB'>, appId: string, id: string, opts: { allowExternal: boolean }, by: string, now = Date.now()): Promise<EmailIdentity> {
  await identityById(env, appId, id);
  await env.DB.prepare("UPDATE email_identities SET status = 'approved', allow_external = ?, approved_at = ?, approved_by = ?, revoked_at = NULL, revoked_by = NULL WHERE id = ?")
    .bind(opts.allowExternal ? 1 : 0, now, by, id).run();
  return identityOut(await identityById(env, appId, id));
}

export async function revokeIdentity(env: Pick<Env, 'DB'>, appId: string, id: string, by: string, now = Date.now()): Promise<EmailIdentity> {
  await identityById(env, appId, id);
  await env.DB.prepare("UPDATE email_identities SET status = 'revoked', revoked_at = ?, revoked_by = ? WHERE id = ?").bind(now, by, id).run();
  return identityOut(await identityById(env, appId, id));
}

/** Administrator kill switch for one identity. */
export async function suspendIdentity(env: Pick<Env, 'DB'>, appId: string, id: string, suspended: boolean, reason: string | null): Promise<EmailIdentity> {
  await identityById(env, appId, id);
  await env.DB.prepare('UPDATE email_identities SET suspended = ?, suspended_reason = ? WHERE id = ?').bind(suspended ? 1 : 0, suspended ? reason : null, id).run();
  return identityOut(await identityById(env, appId, id));
}

/** Administrator kill switch for every identity of an app, with optional quota overrides (null = platform default). */
export async function setAppEmailControls(
  env: Pick<Env, 'DB'>, appId: string,
  c: { suspended?: boolean; reason?: string | null; dailyLimit?: number | null | undefined; identityDailyLimit?: number | null | undefined; burstLimit?: number | null | undefined },
  by: string, now = Date.now(),
): Promise<void> {
  const limit = (v: unknown) => (v === undefined || v === null ? null : Number.isInteger(v) && (v as number) >= 0 ? (v as number) : (() => { throw new EmailError('invalid_request', 'limits are non-negative integers'); })());
  await env.DB.prepare(
    `INSERT INTO email_app_settings (app_id, suspended, suspended_reason, suspended_by, suspended_at, daily_limit, identity_daily_limit, burst_limit)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT(app_id) DO UPDATE SET suspended = ?2, suspended_reason = ?3, suspended_by = ?4, suspended_at = ?5,
       daily_limit = ?6, identity_daily_limit = ?7, burst_limit = ?8`,
  ).bind(appId, c.suspended ? 1 : 0, c.suspended ? (c.reason ?? null) : null, c.suspended ? by : null, c.suspended ? now : null,
    limit(c.dailyLimit), limit(c.identityDailyLimit), limit(c.burstLimit)).run();
}

interface SettingsRow { suspended: number; suspended_reason: string | null; daily_limit: number | null; identity_daily_limit: number | null; burst_limit: number | null }
const settingsOf = (env: Pick<Env, 'DB'>, appId: string) =>
  env.DB.prepare('SELECT suspended, suspended_reason, daily_limit, identity_daily_limit, burst_limit FROM email_app_settings WHERE app_id = ?').bind(appId).first<SettingsRow>();

/** Owner-readable state. Never a secret: provider keys and webhook secrets are not in the database. */
export async function emailStatus(env: Pick<Env, 'DB' | 'RESEND_API_KEY'>, appId: string, now = Date.now()) {
  const [domains, identities, settings, counts] = await Promise.all([
    env.DB.prepare('SELECT * FROM email_domains WHERE app_id = ? ORDER BY domain').bind(appId).all<DomainRow>(),
    env.DB.prepare(`${IDENTITY_SELECT} WHERE i.app_id = ? ORDER BY i.address`).bind(appId).all<IdentityRow>(),
    settingsOf(env, appId),
    env.DB.prepare("SELECT COUNT(*) AS day, SUM(CASE WHEN created_at > ?2 THEN 1 ELSE 0 END) AS minute FROM email_sends WHERE app_id = ?1 AND created_at > ?3 AND status != 'refused'")
      .bind(appId, now - MINUTE_MS, now - DAY_MS).first<{ day: number; minute: number | null }>(),
  ]);
  return {
    configured: Boolean(env.RESEND_API_KEY),
    suspended: settings?.suspended === 1,
    suspendedReason: settings?.suspended === 1 ? settings.suspended_reason : null,
    limits: { daily: settings?.daily_limit ?? EMAIL_LIMITS.appDaily, identityDaily: settings?.identity_daily_limit ?? EMAIL_LIMITS.identityDaily, burstPerMinute: settings?.burst_limit ?? EMAIL_LIMITS.burst },
    usage: { last24h: counts?.day ?? 0, lastMinute: counts?.minute ?? 0 },
    domains: (domains.results ?? []).map(domainOut),
    identities: (identities.results ?? []).map(identityOut),
  };
}

// ── bodies ──────────────────────────────────────────────────────────────────

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * `text` is plain text and is escaped before it is ever placed in HTML. `html` is the
 * app's own markup, sent as the HTML part only and never copied into the text part
 * except as tag-stripped text. The two are never the same string.
 */
export function renderBodies(input: { text?: unknown; html?: unknown }): { text: string; html: string } {
  const text = input.text === undefined || input.text === null ? undefined : input.text;
  const html = input.html === undefined || input.html === null ? undefined : input.html;
  if ((text !== undefined && typeof text !== 'string') || (html !== undefined && typeof html !== 'string')) throw new EmailError('invalid_request', 'text and html must be strings');
  if (!text && !html) throw new EmailError('invalid_request', 'text or html is required');
  if ((text?.length ?? 0) > EMAIL_LIMITS.maxBodyChars || (html?.length ?? 0) > EMAIL_LIMITS.maxBodyChars) throw new EmailError('invalid_request', `a body is limited to ${EMAIL_LIMITS.maxBodyChars} characters`);
  if (text && html) return { text, html };
  if (text) return { text, html: `<div>${escapeHtml(text).replace(/\r?\n/g, '<br>\n')}</div>` };
  const stripped = html!
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n').trim();
  return { text: stripped || ' ', html: html! };
}

// ── the send primitive ──────────────────────────────────────────────────────

export interface SendAppEmailInput {
  appId: string;
  /** The app's own identity: its id or its registered address. Never a From. */
  identity: string;
  to: string | string[];
  subject: string;
  text?: string | undefined;
  html?: string | undefined;
  replyTo?: string | undefined;
  /** Required: a retry with the same key and request never sends twice. */
  idempotencyKey: string;
  /** Who asked, for the send record: `user:<id>`, `system:worker`, `system:schedule`. */
  actor: string;
}

export interface SendResult {
  /** The platform send record. */
  id: string;
  /** `accepted`: the provider took it (not delivered). `refused`: the provider rejected it. `unknown`: no answer; retry with the same key. */
  status: 'accepted' | 'refused' | 'unknown';
  providerId: string | null;
  from: string;
  to: string[];
  /** Server time the send record was created, epoch ms. */
  createdAt: number;
  acceptedAt: number | null;
  errorCode: string | null;
  /** True when this answers an earlier request with the same idempotency key. */
  replayed: boolean;
}

interface SendRow {
  id: string; app_id: string; identity_id: string; request_hash: string; from_address: string; to_json: string; status: string;
  error_code: string | null; provider_id: string | null; created_at: number; accepted_at: number | null;
  delivered_at?: number | null; bounced_at?: number | null; complained_at?: number | null; subject?: string; actor?: string;
}
const sendOut = (r: SendRow, replayed: boolean): SendResult => ({
  id: r.id, status: (r.status === 'sending' ? 'unknown' : r.status) as SendResult['status'], providerId: r.provider_id, from: r.from_address,
  to: JSON.parse(r.to_json) as string[], createdAt: r.created_at, acceptedAt: r.accepted_at, errorCode: r.error_code, replayed,
});

function formatFrom(i: IdentityRow): string {
  return i.display_name ? `"${i.display_name}" <${i.address}>` : i.address;
}

/** Recipients that already have a relationship to the app: its creator, team members and app-role holders. */
async function relatedAddresses(env: Pick<Env, 'DB'>, appId: string, addresses: string[]): Promise<Set<string>> {
  const marks = addresses.map(() => '?').join(',');
  const rows = await env.DB.prepare(
    `SELECT lower(u.email) AS email FROM users u
      WHERE lower(u.email) IN (${marks})
        AND (u.id = (SELECT creator_id FROM apps WHERE id = ?)
          OR EXISTS (SELECT 1 FROM team_members t WHERE t.app_id = ? AND t.user_id = u.id)
          OR EXISTS (SELECT 1 FROM app_roles r WHERE r.app_id = ? AND (r.user_id = u.id OR (u.provider = 'github' AND r.user_id = u.login))))`,
  ).bind(...addresses, appId, appId, appId).all<{ email: string }>();
  return new Set((rows.results ?? []).map((r) => r.email));
}

/** Fields a caller must never supply: the platform decides them. A caller that tries is told so, not silently ignored. */
const SERVER_DECIDED = ['from', 'sender', 'providerId', 'provider_id', 'messageId', 'sentAt', 'timestamp', 'createdAt', 'appId', 'headers'];
export function assertNoServerDecidedFields(body: Record<string, unknown>): void {
  const bad = SERVER_DECIDED.filter((k) => k in body);
  if (bad.length) throw new EmailError('invalid_request', `${bad.join(', ')} cannot be set by the caller; the sender is the registered identity`);
}

function validateInput(input: SendAppEmailInput): { to: string[]; subject: string; replyTo: string | null; bodies: { text: string; html: string } } {
  if (typeof input.idempotencyKey !== 'string' || !IDEM_KEY.test(input.idempotencyKey)) throw new EmailError('invalid_request', 'idempotencyKey is required (1-200 characters of A-Z a-z 0-9 . _ : -)');
  if (typeof input.identity !== 'string' || !input.identity) throw new EmailError('invalid_request', 'identity is required');
  const raw = Array.isArray(input.to) ? input.to : [input.to];
  if (raw.length === 0 || raw.length > EMAIL_LIMITS.maxRecipients || raw.some((a) => typeof a !== 'string')) throw new EmailError('invalid_request', `to needs 1-${EMAIL_LIMITS.maxRecipients} addresses`);
  const to = [...new Set(raw.map(normalizeAddress))];
  if (to.some((a) => !isLikelyEmail(a) || hasLineBreak(a) || /[<>,;"]/.test(a))) throw new EmailError('invalid_request', 'to has an invalid email address');
  if (typeof input.subject !== 'string' || !input.subject.trim() || input.subject.length > EMAIL_LIMITS.maxSubject || hasLineBreak(input.subject)) {
    throw new EmailError('invalid_request', `subject is required, at most ${EMAIL_LIMITS.maxSubject} characters, on one line`);
  }
  let replyTo: string | null = null;
  if (input.replyTo !== undefined && input.replyTo !== null && input.replyTo !== '') {
    replyTo = typeof input.replyTo === 'string' ? normalizeAddress(input.replyTo) : '';
    if (!isLikelyEmail(replyTo) || hasLineBreak(replyTo) || /[<>,;"]/.test(replyTo)) throw new EmailError('invalid_request', 'replyTo is not a valid email address');
  }
  return { to, subject: input.subject.trim(), replyTo, bodies: renderBodies(input) };
}

async function callProvider(env: Env, apiKey: string, row: SendRow, message: resend.ResendSend, now: number): Promise<SendRow> {
  let providerId: string | null = null;
  let status: 'accepted' | 'refused' | 'unknown';
  let errorCode: string | null = null;
  try {
    providerId = await resend.sendMessage(apiKey, message, `pas-${row.id}`);
    status = 'accepted';
  } catch (e) {
    if (!(e instanceof resend.ResendError)) throw e;
    status = e.retryable ? 'unknown' : 'refused';
    errorCode = e.retryable ? 'provider_unavailable' : 'provider_rejected';
    console.error(`[app-email] send ${row.id} (${row.app_id}) ${status}: ${e.message}`);
  }
  await env.DB.prepare(
    "UPDATE email_sends SET status = ?, provider_id = COALESCE(?, provider_id), error_code = ?, accepted_at = CASE WHEN ? = 'accepted' THEN ? ELSE accepted_at END WHERE id = ? AND status IN ('sending', 'unknown')",
  ).bind(status, providerId, errorCode, status, now, row.id).run();
  return (await env.DB.prepare('SELECT * FROM email_sends WHERE id = ?').bind(row.id).first<SendRow>())!;
}

/**
 * Send one message from one of the app's verified identities. See the file header for the
 * rules. Throws `EmailError` for every refusal made before the provider is called; a provider
 * outcome is a `SendResult` status instead.
 */
export async function sendAppEmail(env: Env, input: SendAppEmailInput, now = Date.now()): Promise<SendResult> {
  const apiKey = requireKey(env);
  const { to, subject, replyTo, bodies } = validateInput(input);
  const { appId } = input;

  const settings = await settingsOf(env, appId);
  if (settings?.suspended === 1) throw new EmailError('app_suspended', 'email is suspended for this app');

  const identity = await env.DB.prepare(`${IDENTITY_SELECT} WHERE i.app_id = ? AND (i.id = ? OR i.address = ?)`)
    .bind(appId, input.identity, normalizeAddress(input.identity)).first<IdentityRow>();
  if (!identity) throw new EmailError('sender_not_found', 'no such sender identity for this app');
  if (identity.status === 'revoked') throw new EmailError('sender_revoked', identity.address);
  if (identity.status !== 'approved') throw new EmailError('sender_not_approved', identity.address);
  if (identity.suspended === 1) throw new EmailError('sender_suspended', identity.address);
  if (identity.domain_status !== 'verified') throw new EmailError('sender_domain_unverified', identity.domain);

  const requestHash = await sha256Hex(JSON.stringify([identity.id, to, subject, input.text ?? null, input.html ?? null, replyTo]));
  const message: resend.ResendSend = {
    from: formatFrom(identity), to, subject, html: bodies.html, text: bodies.text,
    ...((replyTo ?? identity.reply_to) ? { reply_to: (replyTo ?? identity.reply_to)! } : {}),
  };

  const prior = await env.DB.prepare('SELECT * FROM email_sends WHERE app_id = ? AND idem_key = ?').bind(appId, input.idempotencyKey).first<SendRow>();
  if (prior) return replay(env, apiKey, prior, requestHash, message, now);

  if (!identity.allow_external) {
    const related = await relatedAddresses(env, appId, to);
    const outside = to.filter((a) => !related.has(a));
    if (outside.length) throw new EmailError('external_recipient_not_allowed', `${outside.join(', ')} is not related to this app; the owner must allow external recipients for ${identity.address}`);
  }
  const suppressed = await env.DB.prepare(`SELECT address FROM email_suppressions WHERE app_id = ? AND address IN (${to.map(() => '?').join(',')})`)
    .bind(appId, ...to).all<{ address: string }>();
  if (suppressed.results?.length) throw new EmailError('recipient_suppressed', suppressed.results.map((r) => r.address).join(', '));

  // Reserve the quota slot and the idempotency key in one statement, so concurrent sends cannot all pass a count.
  const limits = { app: settings?.daily_limit ?? EMAIL_LIMITS.appDaily, identity: settings?.identity_daily_limit ?? EMAIL_LIMITS.identityDaily, burst: settings?.burst_limit ?? EMAIL_LIMITS.burst };
  const id = crypto.randomUUID();
  let reserved: { meta: { changes?: number } };
  try {
    reserved = await env.DB.prepare(
      `INSERT INTO email_sends (id, app_id, identity_id, idem_key, request_hash, from_address, to_json, subject, status, actor, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'sending', ?9, ?10
        WHERE (SELECT COUNT(*) FROM email_sends WHERE app_id = ?2 AND created_at > ?11 AND status != 'refused') < ?13
          AND (SELECT COUNT(*) FROM email_sends WHERE identity_id = ?3 AND created_at > ?11 AND status != 'refused') < ?14
          AND (SELECT COUNT(*) FROM email_sends WHERE app_id = ?2 AND created_at > ?12 AND status != 'refused') < ?15`,
    ).bind(id, appId, identity.id, input.idempotencyKey, requestHash, identity.address, JSON.stringify(to), subject, input.actor, now,
      now - DAY_MS, now - MINUTE_MS, limits.app, limits.identity, limits.burst).run();
  } catch (e) {
    if (/UNIQUE/i.test(String((e as Error)?.message))) {
      const raced = await env.DB.prepare('SELECT * FROM email_sends WHERE app_id = ? AND idem_key = ?').bind(appId, input.idempotencyKey).first<SendRow>();
      if (raced) return replay(env, apiKey, raced, requestHash, message, now);
    }
    throw e;
  }
  if (!reserved.meta.changes) {
    const c = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM email_sends WHERE app_id = ?1 AND created_at > ?3 AND status != 'refused') AS app_day,
              (SELECT COUNT(*) FROM email_sends WHERE identity_id = ?2 AND created_at > ?3 AND status != 'refused') AS identity_day`,
    ).bind(appId, identity.id, now - DAY_MS).first<{ app_day: number; identity_day: number }>();
    if ((c?.app_day ?? 0) >= limits.app) throw new EmailError('quota_app_daily', `${limits.app} emails per day for this app`);
    if ((c?.identity_day ?? 0) >= limits.identity) throw new EmailError('quota_identity_daily', `${limits.identity} emails per day for ${identity.address}`);
    throw new EmailError('quota_burst', `${limits.burst} emails per minute for this app`);
  }
  const row = (await env.DB.prepare('SELECT * FROM email_sends WHERE id = ?').bind(id).first<SendRow>())!;
  return sendOut(await callProvider(env, apiKey, row, message, now), false);
}

/** The same idempotency key again: the same request returns its record; a different one is a conflict. */
async function replay(env: Env, apiKey: string, prior: SendRow, requestHash: string, message: resend.ResendSend, now: number): Promise<SendResult> {
  if (prior.request_hash !== requestHash) throw new EmailError('idempotency_conflict', 'this idempotency key was used for a different message');
  // Not yet answered by the provider: ask again under the provider's own idempotency key, which cannot double-send.
  if (prior.status === 'sending' || prior.status === 'unknown') return sendOut(await callProvider(env, apiKey, prior, message, now), true);
  return sendOut(prior, true);
}

// ── reads ───────────────────────────────────────────────────────────────────

/** One send record of this app, with its delivery events. Another app's id is simply not found. */
export async function getSend(env: Pick<Env, 'DB'>, appId: string, id: string) {
  const row = await env.DB.prepare('SELECT * FROM email_sends WHERE app_id = ? AND id = ?').bind(appId, String(id)).first<SendRow>();
  if (!row) throw new EmailError('not_found', 'no such send for this app');
  const events = await env.DB.prepare('SELECT type, detail, occurred_at FROM email_send_events WHERE send_id = ? ORDER BY occurred_at, rowid').bind(row.id)
    .all<{ type: string; detail: string | null; occurred_at: number }>();
  return {
    ...sendOut(row, false), subject: row.subject ?? '', actor: row.actor ?? '',
    deliveredAt: row.delivered_at ?? null, bouncedAt: row.bounced_at ?? null, complainedAt: row.complained_at ?? null,
    events: (events.results ?? []).map((e) => ({ type: e.type, at: e.occurred_at, detail: e.detail ? JSON.parse(e.detail) as unknown : null })),
  };
}

export async function listSends(env: Pick<Env, 'DB'>, appId: string, limit: number) {
  const rows = await env.DB.prepare('SELECT * FROM email_sends WHERE app_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').bind(appId, limit).all<SendRow>();
  return (rows.results ?? []).map((r) => ({ ...sendOut(r, false), subject: r.subject ?? '', deliveredAt: r.delivered_at ?? null, bouncedAt: r.bounced_at ?? null, complainedAt: r.complained_at ?? null }));
}

export async function listSuppressions(env: Pick<Env, 'DB'>, appId: string) {
  const rows = await env.DB.prepare('SELECT address, reason, created_at FROM email_suppressions WHERE app_id = ? ORDER BY created_at DESC LIMIT 500').bind(appId)
    .all<{ address: string; reason: string; created_at: number }>();
  return (rows.results ?? []).map((r) => ({ address: r.address, reason: r.reason, at: r.created_at }));
}

/** The app's sender identities, for a worker choosing which to use. */
export async function listIdentities(env: Pick<Env, 'DB'>, appId: string): Promise<EmailIdentity[]> {
  const rows = await env.DB.prepare(`${IDENTITY_SELECT} WHERE i.app_id = ? ORDER BY i.address`).bind(appId).all<IdentityRow>();
  return (rows.results ?? []).map(identityOut);
}
