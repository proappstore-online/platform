/**
 * Per-app license keys.
 *
 * ENTITLEMENT RULE (#86): a license is only good while the user it belongs to
 * has an ACTIVE subscription. The keys themselves carry no expiry in practice
 * (`expires_at` is nullable and nothing sets it), so without this check a key
 * issued once would validate forever — the Stripe webhook flips
 * `subscriptions.status` on cancel but never touches `licenses`.
 *
 * The join is on `user_id` ALONE. PAS sells one platform-wide subscription that
 * unlocks every Pro app; `subscriptions` is keyed by `user_id` and has no
 * `app_id` column. Joining on app would not just be wrong, it would not compile
 * against the schema.
 *
 * ISSUANCE (#86): `POST /apps/:appId/license` mints the caller's key. It is
 * gated on an active subscription up front, so a lapsed subscriber cannot even
 * obtain a key, and it is idempotent — a second call returns the existing
 * un-revoked, un-expired key rather than minting another. Keys are 32 bytes
 * from crypto.getRandomValues (256 bits), base64url. `DELETE` revokes the
 * caller's own keys for the app — the compromised-key case, where the
 * subscription is still active and the join above would keep validating.
 */

import { Hono } from 'hono';
import type { Env, LicenseRow } from '../types.js';
import { requireUser } from '../lib/auth.js';
import { wrap } from '../lib/route-wrap.js';
import {
  MAX_VALIDATE_ATTEMPTS,
  MAX_VALIDATE_IP_ATTEMPTS,
  consumeValidateAttempt,
  validateAttemptKey,
  validateIpKey,
} from '../lib/license-rate-limit.js';
import { APP_ID_RE } from './validation.js';

export const licenseRoutes = new Hono<{ Bindings: Env }>();

/** Bytes of randomness in a license key. 32 bytes = 256 bits (#86 asks for ≥128). */
export const LICENSE_KEY_BYTES = 32;

/** A fresh license key: 256 random bits, base64url without padding (43 chars). */
export function mintLicenseKey(): string {
  const buf = crypto.getRandomValues(new Uint8Array(LICENSE_KEY_BYTES));
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function licenseJson(row: Pick<LicenseRow, 'key' | 'app_id' | 'issued_at' | 'expires_at'>) {
  return { key: row.key, appId: row.app_id, issuedAt: row.issued_at, expiresAt: row.expires_at };
}

/** Get the current user's license for an app. */
licenseRoutes.get('/apps/:appId/license', wrap(async (c) => {
  const user = await requireUser(c);
  const { appId } = c.req.param();

  // LEFT JOIN rather than an inner join so the three failure modes stay
  // distinguishable. This route is authenticated and returns the caller's own
  // license, so a precise reason leaks nothing and "your subscription lapsed"
  // is actionable in a way that a bare 404 is not.
  const row = await c.env.DB.prepare(
    `SELECT l.*, s.status AS sub_status
       FROM licenses l
       LEFT JOIN subscriptions s ON s.user_id = l.user_id
      WHERE l.app_id = ? AND l.user_id = ? AND l.revoked = 0`,
  )
    .bind(appId, user.id)
    .first<LicenseRow & { sub_status: string | null }>();

  if (!row) return c.text('not found', 404);

  // Check expiry
  if (row.expires_at && row.expires_at < Date.now()) {
    return c.text('license expired', 404);
  }

  // Entitlement follows the subscription (#86), not the key.
  if (row.sub_status !== 'active') {
    return c.text('subscription inactive', 403);
  }

  return c.json(licenseJson(row));
}));

/**
 * Issue the current user's license for an app (#86).
 *
 * 200 with the existing key when one is live, 201 when a new one was minted,
 * 403 when the caller has no active subscription. The subscription check comes
 * FIRST so that a lapsed user cannot mint a key that the validate join would
 * refuse anyway — no orphaned rows, nothing to clean up on cancel.
 */
licenseRoutes.post('/apps/:appId/license', wrap(async (c) => {
  const user = await requireUser(c);
  const appId = c.req.param('appId')!;

  const sub = await c.env.DB.prepare(
    'SELECT status FROM subscriptions WHERE user_id = ?',
  ).bind(user.id).first<{ status: string }>();
  if (sub?.status !== 'active') return c.text('subscription inactive', 403);

  const now = Date.now();
  // Idempotent: a live key is returned, not replaced. Revoke first to rotate.
  const existing = await c.env.DB.prepare(
    `SELECT key, app_id, issued_at, expires_at
       FROM licenses
      WHERE app_id = ? AND user_id = ? AND revoked = 0
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY issued_at DESC
      LIMIT 1`,
  ).bind(appId, user.id, now).first<Pick<LicenseRow, 'key' | 'app_id' | 'issued_at' | 'expires_at'>>();
  if (existing) return c.json(licenseJson(existing));

  const key = mintLicenseKey();
  await c.env.DB.prepare(
    `INSERT INTO licenses (key, app_id, user_id, issued_at, expires_at, revoked)
     VALUES (?, ?, ?, ?, NULL, 0)`,
  ).bind(key, appId, user.id, now).run();

  return c.json(licenseJson({ key, app_id: appId, issued_at: now, expires_at: null }), 201);
}));

/**
 * Revoke the current user's license(s) for an app (#86). Covers the case the
 * subscription join cannot: a key that leaked while the subscription is still
 * active. Revocation is permanent; `POST` mints a replacement.
 */
licenseRoutes.delete('/apps/:appId/license', wrap(async (c) => {
  const user = await requireUser(c);
  const { appId } = c.req.param();
  const result = await c.env.DB.prepare(
    'UPDATE licenses SET revoked = 1 WHERE app_id = ? AND user_id = ? AND revoked = 0',
  ).bind(appId, user.id).run();
  return c.json({ revoked: result.meta?.changes ?? 0 });
}));

/** Validate a license key (no auth required — for offline validation). */
licenseRoutes.post('/license/validate', async (c) => {
  const body = await c.req.json<{ appId: string; key: string }>().catch(() => null);
  const appId = body?.appId;
  const key = body?.key;
  if (typeof appId !== 'string' || typeof key !== 'string' || !appId || !key) return c.json({ valid: false });
  // A malformed app id can match no license: answer before touching D1.
  if (!APP_ID_RE.test(appId)) return c.json({ valid: false });

  // Throttle BEFORE the lookup (#86): the DB read is the cost being bounded,
  // and a license key is a guessable bearer credential. 429 rather than a
  // `valid:false` — a throttled caller has not been told anything about the
  // key, and silently answering "invalid" would make a rate-limited legitimate
  // app believe its key had been revoked.
  //
  // Two buckets (#324). `appId` is caller-chosen, so the per-IP ceiling comes
  // first and is spent whatever the id; rotating ids cannot buy budget. The
  // per-(ip, app) bucket is claimed only for an app in the registry, so an
  // invented id never creates a limiter row of its own.
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  const now = Date.now();
  const tooMany = () => c.json({ error: 'too many validation attempts' }, 429);
  if (!(await consumeValidateAttempt(c.env.DB, validateIpKey(ip), MAX_VALIDATE_IP_ATTEMPTS, now))) return tooMany();
  const known = await c.env.DB.prepare('SELECT 1 AS ok FROM apps WHERE id = ?').bind(appId).first();
  if (!known) return c.json({ valid: false });
  if (!(await consumeValidateAttempt(c.env.DB, validateAttemptKey(ip, appId), MAX_VALIDATE_ATTEMPTS, now))) return tooMany();

  // Inner join, and every failure returns the same bare `valid:false` — this
  // route is unauthenticated, so distinguishing "no such key" from "key exists
  // but the subscription lapsed" would confirm a guessed key to an attacker.
  const row = await c.env.DB.prepare(
    `SELECT l.expires_at
       FROM licenses l
       JOIN subscriptions s ON s.user_id = l.user_id
      WHERE l.app_id = ? AND l.key = ? AND l.revoked = 0 AND s.status = 'active'`,
  )
    .bind(appId, key)
    .first<Pick<LicenseRow, 'expires_at'>>();

  if (!row) return c.json({ valid: false });
  if (row.expires_at && row.expires_at < Date.now()) return c.json({ valid: false });

  return c.json({ valid: true });
});
