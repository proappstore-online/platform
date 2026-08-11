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
 * NOTE: nothing in this repo issues a license — there is no INSERT into
 * `licenses` anywhere, so the table is empty in practice and both routes are
 * inert today. These checks exist so that whoever builds issuance inherits a
 * correct read path rather than this hole. See #86 for what issuance still owes:
 * key entropy, and revocation semantics beyond the subscription join.
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

    return c.json({
      key: row.key,
      appId: row.app_id,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
    });
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
