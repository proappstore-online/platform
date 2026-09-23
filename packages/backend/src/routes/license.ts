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
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env, LicenseRow } from '../types.js';
import { requireUser, HttpError } from '../lib/auth.js';
import {
  consumeValidateAttempt,
  d1ValidateAttemptStore,
  validateAttemptKey,
} from '../lib/license-rate-limit.js';

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
licenseRoutes.get('/apps/:appId/license', async (c) => {
  try {
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
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

/**
 * Issue the current user's license for an app (#86).
 *
 * 200 with the existing key when one is live, 201 when a new one was minted,
 * 403 when the caller has no active subscription. The subscription check comes
 * FIRST so that a lapsed user cannot mint a key that the validate join would
 * refuse anyway — no orphaned rows, nothing to clean up on cancel.
 */
licenseRoutes.post('/apps/:appId/license', async (c) => {
  try {
    const user = await requireUser(c);
    const { appId } = c.req.param();

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
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

/**
 * Revoke the current user's license(s) for an app (#86). Covers the case the
 * subscription join cannot: a key that leaked while the subscription is still
 * active. Revocation is permanent; `POST` mints a replacement.
 */
licenseRoutes.delete('/apps/:appId/license', async (c) => {
  try {
    const user = await requireUser(c);
    const { appId } = c.req.param();
    const result = await c.env.DB.prepare(
      'UPDATE licenses SET revoked = 1 WHERE app_id = ? AND user_id = ? AND revoked = 0',
    ).bind(appId, user.id).run();
    return c.json({ revoked: result.meta?.changes ?? 0 });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

/** Validate a license key (no auth required — for offline validation). */
licenseRoutes.post('/license/validate', async (c) => {
  const body = await c.req.json<{ appId: string; key: string }>().catch(() => null);
  const appId = body?.appId;
  const key = body?.key;
  if (!appId || !key) return c.json({ valid: false });

  // Throttle BEFORE the lookup (#86): the DB read is the cost being bounded,
  // and a license key is a guessable bearer credential. 429 rather than a
  // `valid:false` — a throttled caller has not been told anything about the
  // key, and silently answering "invalid" would make a rate-limited legitimate
  // app believe its key had been revoked.
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  const allowed = await consumeValidateAttempt(
    d1ValidateAttemptStore(c.env.DB),
    validateAttemptKey(ip, appId),
    Date.now(),
  );
  if (!allowed) return c.json({ error: 'too many validation attempts' }, 429);

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
