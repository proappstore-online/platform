import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env, LicenseRow } from '../types.js';
import { requireUser, HttpError } from '../lib/auth.js';

export const licenseRoutes = new Hono<{ Bindings: Env }>();

/** Get the current user's license for an app. */
licenseRoutes.get('/apps/:appId/license', async (c) => {
  try {
    const user = await requireUser(c);
    const { appId } = c.req.param();

    const row = await c.env.DB.prepare(
      'SELECT * FROM licenses WHERE app_id = ? AND user_id = ? AND revoked = 0',
    )
      .bind(appId, user.id)
      .first<LicenseRow>();

    if (!row) return c.text('not found', 404);

    // Check expiry
    if (row.expires_at && row.expires_at < Date.now()) {
      return c.text('license expired', 404);
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
  const { appId, key } = await c.req.json<{ appId: string; key: string }>();
  if (!appId || !key) return c.json({ valid: false });

  const row = await c.env.DB.prepare(
    'SELECT * FROM licenses WHERE app_id = ? AND key = ? AND revoked = 0',
  )
    .bind(appId, key)
    .first<LicenseRow>();

  if (!row) return c.json({ valid: false });
  if (row.expires_at && row.expires_at < Date.now()) return c.json({ valid: false });

  return c.json({ valid: true });
});
