/**
 * Enquiries from an app's about- marketing site (#412, epic #411).
 *
 *   POST  /v1/apps/:appId/enquiries               public: { name, email, message } from about-<appId>
 *   GET   /v1/apps/:appId/enquiries?status=&before=   owner: newest first, with the count of new ones
 *   GET   /v1/apps/:appId/enquiries/:id            owner
 *   PATCH /v1/apps/:appId/enquiries/:id            owner: { status: 'new' | 'handled' }
 *
 * Enquiries are stored in the platform per app — not emailed out, not in the
 * app's own data — and only the app's owner (or a platform admin) reads them.
 * Every app takes enquiries, private ones included: the marketing site is public.
 *
 * The POST takes a plain HTML form (answered with a 303 back to the site, so it
 * works without JavaScript) or JSON. Spam protection: the request must come from
 * the app's about- origin; a filled honeypot field is accepted and discarded;
 * lengths and the email shape are checked; at most ENQUIRY_IP_LIMIT per client IP
 * per app per hour and ENQUIRY_APP_DAILY_LIMIT per app per day are stored.
 */

import { Hono, type Context } from 'hono';
import { HttpError, requireAppOwner } from '../lib/auth.js';
import { privateNoStore } from '../lib/route-wrap.js';
import type { Env } from '../types.js';

export const ENQUIRY_IP_LIMIT = 5;
export const ENQUIRY_APP_DAILY_LIMIT = 200;
/** The form field a person never sees or fills; a bot that fills it is discarded. */
export const ENQUIRY_HONEYPOT = 'website';
const MAX_NAME = 100;
const MAX_EMAIL = 254;
const MAX_MESSAGE = 5000;
const MAX_BODY_BYTES = 16 * 1024;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ID_RE = /^[0-9a-f-]{36}$/;

export const enquiryRoutes = new Hono<{ Bindings: Env }>();
enquiryRoutes.use('/apps/:appId/enquiries', privateNoStore);
enquiryRoutes.use('/apps/:appId/enquiries/*', privateNoStore);

export function aboutOrigin(appId: string): string {
  return `https://about-${appId}.proappstore.online`;
}

type Outcome = 'sent' | 'invalid' | 'rate-limited';

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The trimmed field, or an error naming it. */
function field(body: Record<string, unknown>, name: string, max: number): string | { error: string } {
  const value = typeof body[name] === 'string' ? (body[name] as string).trim() : '';
  if (!value) return { error: `${name} is required` };
  if (value.length > max) return { error: `${name} too long (max ${max} characters)` };
  return value;
}

enquiryRoutes.post('/apps/:appId/enquiries', async (c) => {
  const appId = c.req.param('appId')!;
  const isForm = /application\/x-www-form-urlencoded|multipart\/form-data/i.test(c.req.header('Content-Type') ?? '');
  /** A form post goes back to the site with the outcome; an API caller gets JSON. */
  const answer = (outcome: Outcome, status: 201 | 400 | 429, extra: Record<string, unknown> = {}) =>
    isForm
      ? c.redirect(`${aboutOrigin(appId)}/?enquiry=${outcome}#enquiry-${outcome}`, 303)
      : c.json({ ok: outcome === 'sent', ...(outcome === 'sent' ? {} : { error: outcome }), ...extra }, status);

  if (!/^[a-z][a-z0-9-]{0,56}$/.test(appId) || !(await c.env.DB.prepare('SELECT 1 FROM apps WHERE id = ?').bind(appId).first())) {
    throw new HttpError('app not found', 404);
  }
  // Only the app's own marketing site may post: a browser always sends Origin on a cross-origin POST.
  if (c.req.header('Origin') !== aboutOrigin(appId)) throw new HttpError('enquiries are accepted from the app\'s about- site only', 403);
  if (Number(c.req.header('Content-Length') ?? 0) > MAX_BODY_BYTES) throw new HttpError('enquiry too large', 413);

  let body: Record<string, unknown>;
  try {
    body = isForm ? ((await c.req.parseBody()) as Record<string, unknown>) : ((await c.req.json()) as Record<string, unknown>);
  } catch {
    return answer('invalid', 400, { detail: 'unreadable body' });
  }
  if (!body || typeof body !== 'object') return answer('invalid', 400, { detail: 'unreadable body' });

  // Honeypot: answer exactly like a success, store nothing.
  if (typeof body[ENQUIRY_HONEYPOT] === 'string' && (body[ENQUIRY_HONEYPOT] as string).trim() !== '') return answer('sent', 201);

  const name = field(body, 'name', MAX_NAME);
  const email = field(body, 'email', MAX_EMAIL);
  const message = field(body, 'message', MAX_MESSAGE);
  for (const v of [name, email, message]) if (typeof v !== 'string') return answer('invalid', 400, { detail: v.error });
  if (!EMAIL_RE.test(email as string)) return answer('invalid', 400, { detail: 'email is not an email address' });

  const now = Date.now();
  const ipHash = await sha256Hex(`${appId}\u0000${c.req.header('CF-Connecting-IP') ?? 'unknown'}`);
  // #429: the limits and the insert are one statement. A separate count-then-insert
  // let a burst of simultaneous posts all see the same count and all be stored,
  // past both the per-IP and the per-app daily limit.
  const id = crypto.randomUUID();
  const stored = await c.env.DB.prepare(
    `INSERT INTO app_enquiries (id, app_id, name, email, message, status, ip_hash, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, 'new', ?6, ?7
      WHERE (SELECT COUNT(*) FROM app_enquiries WHERE app_id = ?2 AND ip_hash = ?6 AND created_at > ?8) < ?10
        AND (SELECT COUNT(*) FROM app_enquiries WHERE app_id = ?2 AND created_at > ?9) < ?11`,
  ).bind(id, appId, name, email, message, ipHash, now, now - HOUR_MS, now - DAY_MS, ENQUIRY_IP_LIMIT, ENQUIRY_APP_DAILY_LIMIT).run();
  if (!stored.meta?.changes) {
    c.header('Retry-After', '3600');
    return answer('rate-limited', 429);
  }
  return answer('sent', 201, { id });
});

interface EnquiryRow {
  id: string;
  name: string;
  email: string;
  message: string;
  status: string;
  created_at: number;
  handled_at: number | null;
  handled_by: string | null;
}
const COLUMNS = 'id, name, email, message, status, created_at, handled_at, handled_by';

async function owned(c: Context<{ Bindings: Env }>): Promise<string> {
  const appId = c.req.param('appId')!;
  await requireAppOwner(c, appId);
  return appId;
}

enquiryRoutes.get('/apps/:appId/enquiries', async (c) => {
  const appId = await owned(c);
  const status = c.req.query('status');
  if (status !== undefined && status !== 'new' && status !== 'handled') throw new HttpError("status must be 'new' or 'handled'", 400);
  const before = Number(c.req.query('before') ?? Number.MAX_SAFE_INTEGER);
  if (!Number.isFinite(before)) throw new HttpError('before must be a timestamp', 400);
  // Floored: a fractional LIMIT is a SQLite datatype mismatch (a 500), #429.
  const limit = Math.min(Math.max(Math.floor(Number(c.req.query('limit') ?? 50)) || 50, 1), 100);
  // #431: enquiries that arrive in the same millisecond tie on created_at; rowid
  // (insertion order) breaks the tie, so the order is stable and newest-first.
  // `before_id` (the last id of the previous page) pages on (created_at, rowid),
  // so a tie on the page boundary is neither skipped nor repeated, as a bare
  // `before` timestamp would be. An unknown before_id yields an empty page.
  const beforeId = c.req.query('before_id');
  if (beforeId !== undefined && !ID_RE.test(beforeId)) throw new HttpError('before_id must be an enquiry id', 400);
  const rows = await c.env.DB.prepare(
    `SELECT ${COLUMNS} FROM app_enquiries WHERE app_id = ?1 AND (?2 IS NULL OR status = ?2) AND created_at < ?3
        AND (?5 IS NULL OR (created_at, rowid) < (SELECT created_at, rowid FROM app_enquiries WHERE app_id = ?1 AND id = ?5))
      ORDER BY created_at DESC, rowid DESC LIMIT ?4`,
  ).bind(appId, status ?? null, before, limit, beforeId ?? null).all<EnquiryRow>();
  const counts = await c.env.DB.prepare(
    "SELECT SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) AS new_count, COUNT(*) AS total FROM app_enquiries WHERE app_id = ?",
  ).bind(appId).first<{ new_count: number | null; total: number }>();
  const list = rows.results ?? [];
  // The next page's cursor, when this one is full.
  const next = list.length === limit ? { before_id: list[list.length - 1]!.id } : null;
  return c.json({ enquiries: list, counts: { new: counts?.new_count ?? 0, total: counts?.total ?? 0 }, next });
});

enquiryRoutes.get('/apps/:appId/enquiries/:id', async (c) => {
  const appId = await owned(c);
  const id = c.req.param('id')!;
  const row = ID_RE.test(id)
    ? await c.env.DB.prepare(`SELECT ${COLUMNS} FROM app_enquiries WHERE app_id = ? AND id = ?`).bind(appId, id).first<EnquiryRow>()
    : null;
  if (!row) throw new HttpError('no such enquiry', 404);
  return c.json(row);
});

enquiryRoutes.patch('/apps/:appId/enquiries/:id', async (c) => {
  const appId = c.req.param('appId')!;
  const user = await requireAppOwner(c, appId);
  const id = c.req.param('id')!;
  const body = await c.req.json<{ status?: unknown }>().catch(() => null);
  if (body?.status !== 'new' && body?.status !== 'handled') throw new HttpError("status must be 'new' or 'handled'", 400);
  const handled = body.status === 'handled';
  const res = ID_RE.test(id)
    ? await c.env.DB.prepare('UPDATE app_enquiries SET status = ?3, handled_at = ?4, handled_by = ?5 WHERE app_id = ?1 AND id = ?2')
      .bind(appId, id, body.status, handled ? Date.now() : null, handled ? user.id : null).run()
    : null;
  if (!res?.meta?.changes) throw new HttpError('no such enquiry', 404);
  return c.json({ id, status: body.status });
});
