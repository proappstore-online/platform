import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { verifySession } from '@proappstore/build-core';
import type { Env } from '../types.js';
import { HttpError } from '../lib/auth.js';
import { claimAttempt } from '../lib/credential-rate-limit.js';
import { nativeBody, nativeHash, nativeRandom } from '../lib/native-companion.js';
import { redeemExchangeCode } from './auth.js';

export const nativeAuthRoutes = new Hono<{ Bindings: Env }>();
const PREFIX = '/v1/native/auth';
const COOKIE = '__Host-pas_native_pairing';
const PAIRING_MS = 10 * 60_000;
type Ctx = Context<{ Bindings: Env }>;
interface Pairing { id: string; challenge: string; label: string; user_id: string | null; browser_hash: string | null; approved: number; expires_at: number; }
const hex = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const escape = (s: string) => s.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
const base = (c: Ctx) => (c.env.APP_BASE || 'https://api.proappstore.online').replace(/\/$/, '');
const row = (c: Ctx, id: string) => c.env.DB.prepare('SELECT * FROM native_pairings WHERE id = ? AND expires_at > ?').bind(id, Date.now()).first<Pairing>();
function page(c: Ctx, body: string) {
  c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  return c.html(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect ProAppStore</title><style>body{font:17px system-ui;max-width:440px;margin:64px auto;padding:24px;color:#241638;background:#faf8ff}a,button{display:block;margin:16px 0;padding:16px;border-radius:12px;background:#6d28d9;color:white;text-align:center;border:0;font:inherit}small{display:block;overflow-wrap:anywhere}</style><main>${body}</main></html>`);
}
nativeAuthRoutes.use('/native/auth/*', async (c, next) => {
  c.header('Cache-Control', 'no-store'); c.header('Referrer-Policy', 'no-referrer');
  await next();
});
nativeAuthRoutes.post('/native/auth/start', async c => {
  if (!await claimAttempt(c.env.DB, `native-pair:${await nativeHash(c.req.header('CF-Connecting-IP') || 'unknown')}`, Date.now())) throw new HttpError('Try connecting again later.', 429);
  const body = await nativeBody(c);
  if (!hex(body.challenge) || typeof body.label !== 'string' || !body.label.trim() || body.label.length > 80) throw new HttpError('Invalid device connection.', 400);
  const id = nativeRandom();
  await c.env.DB.prepare('INSERT INTO native_pairings (id, challenge, label, expires_at) VALUES (?, ?, ?, ?)')
    .bind(id, body.challenge, body.label.trim(), Date.now() + PAIRING_MS).run();
  return c.json({ id, authorizationUrl: `${base(c)}${PREFIX}/authorize?id=${id}`, expiresIn: PAIRING_MS / 1000 });
});
nativeAuthRoutes.get('/native/auth/authorize', async c => {
  const id = c.req.query('id') ?? '';
  const pairing = hex(id) ? await row(c, id) : null;
  if (!pairing || pairing.approved || pairing.user_id) throw new HttpError('Connection expired. Start again from the Android app.', 400);
  const nonce = nativeRandom();
  await c.env.DB.prepare('UPDATE native_pairings SET browser_hash = ? WHERE id = ? AND approved = 0 AND user_id IS NULL').bind(await nativeHash(nonce), id).run();
  setCookie(c, COOKIE, `${id}.${nonce}`, { secure: true, httpOnly: true, sameSite: 'Lax', path: '/', maxAge: PAIRING_MS / 1000 });
  const returnTo = `${base(c)}${PREFIX}/callback`;
  const login = (provider: string) => `${base(c)}/v1/auth/${provider}/start?response_mode=query&return_to=${encodeURIComponent(returnTo)}`;
  return page(c, `<h1>Connect your phone</h1><p>Sign in with the same account you use in your PAS apps.</p><p>Device: ${escape(pairing.label)}</p><small>Check this code matches your phone: ${id.slice(0, 8).toUpperCase()}</small><a href="${escape(login('google'))}">Continue with Google</a><a href="${escape(login('github'))}">Continue with GitHub</a><p>This connects your account. Location sharing stays off until you enable an app on your phone.</p>`);
});
async function browserPairing(c: Ctx): Promise<{ pairing: Pairing; nonce: string }> {
  const [id, nonce] = (getCookie(c, COOKIE) ?? '').split('.');
  if (!hex(id) || !hex(nonce)) throw new HttpError('Start this connection from the Android app.', 403);
  const pairing = await row(c, id);
  if (!pairing || pairing.approved || pairing.browser_hash !== await nativeHash(nonce)) throw new HttpError('Connection expired. Start again.', 403);
  return { pairing, nonce };
}
nativeAuthRoutes.get('/native/auth/callback', async c => {
  const { pairing, nonce } = await browserPairing(c);
  const code = c.req.query('code') ?? '';
  const session = code ? await redeemExchangeCode(c.env, code) : null;
  const claims = session ? await verifySession(session, c.env.SESSION_SIGNING_KEY) : null;
  if (!claims) throw new HttpError('Sign-in did not finish. Start again from the Android app.', 401);
  const result = await c.env.DB.prepare('UPDATE native_pairings SET user_id = ? WHERE id = ? AND user_id IS NULL AND approved = 0 AND expires_at > ?')
    .bind(claims.uid, pairing.id, Date.now()).run();
  if (!result.meta.changes) throw new HttpError('Connection already used.', 409);
  return page(c, `<h1>Connect ${escape(pairing.label)}?</h1><p>Account: ${escape(claims.login || claims.uid)}</p><small>Phone code: ${pairing.id.slice(0, 8).toUpperCase()}</small><p>Only continue if you started this request on your phone. No apps receive your location yet.</p><form method="post" action="${PREFIX}/approve"><input type="hidden" name="nonce" value="${nonce}"><button>Connect this phone</button></form>`);
});
nativeAuthRoutes.post('/native/auth/approve', async c => {
  if (c.req.header('Origin') !== new URL(base(c)).origin) throw new HttpError('Invalid approval origin.', 403);
  const { pairing, nonce } = await browserPairing(c);
  const form = await c.req.parseBody();
  if (form.nonce !== nonce || !pairing.user_id) throw new HttpError('Invalid connection approval.', 403);
  await c.env.DB.prepare('UPDATE native_pairings SET approved = 1 WHERE id = ? AND user_id IS NOT NULL AND expires_at > ?').bind(pairing.id, Date.now()).run();
  deleteCookie(c, COOKIE, { secure: true, path: '/' });
  return page(c, '<h1>Phone connected</h1><p>Return to ProAppStore to choose which apps may receive location.</p><a href="proappstore://native/connected">Return to ProAppStore</a>');
});
nativeAuthRoutes.post('/native/auth/complete', async c => {
  const body = await nativeBody(c);
  if (!hex(body.id) || !hex(body.verifier)) throw new HttpError('Invalid connection proof.', 400);
  const challenge = await nativeHash(body.verifier);
  const pairing = await row(c, body.id);
  if (!pairing || pairing.challenge !== challenge) throw new HttpError('Invalid or expired connection.', 403);
  if (!pairing.approved || !pairing.user_id) return c.json({ pending: true }, 202);
  // Only the initiating installation knows the verifier. Atomically consume before issuance.
  const consumed = await c.env.DB.prepare('DELETE FROM native_pairings WHERE id = ? AND challenge = ? AND approved = 1 AND expires_at > ? RETURNING user_id, label')
    .bind(body.id, challenge, Date.now()).first<{ user_id: string; label: string }>();
  if (!consumed) throw new HttpError('Connection already used. Start again.', 409);
  const id = nativeRandom(), token = `ndev_${nativeRandom()}`, now = Date.now();
  await c.env.DB.prepare('INSERT INTO native_devices (id, user_id, label, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, consumed.user_id, consumed.label, await nativeHash(token), now, now + 90 * 24 * 60 * 60_000).run();
  return c.json({ token, deviceId: id });
});
