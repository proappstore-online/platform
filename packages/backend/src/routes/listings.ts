import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from '../types.js';
import { requireAppOwner, HttpError } from '../lib/auth.js';
import type { ListingRow, ListingPatch } from './listing-types.js';
import { rowToDto, emptyDto } from './listing-types.js';
import {
  URL_LIKE,
  BLUESKY_HANDLE,
  MAX_TAGLINE,
  MAX_LONG_DESC,
  MAX_SCREENSHOTS,
  clean,
  urlOrNull,
  emailOrNull,
  hexOrNull,
  handleOrNull,
} from './listing-validation.js';
import {
  ALLOWED_KINDS,
  SCREENSHOT_KIND,
  MAX_ICON,
  MAX_SCREENSHOT,
  MAX_MD,
  IMAGE_TYPES,
  extFor,
} from './listing-assets.js';

export type { ListingDto } from './listing-types.js';

/**
 * Per-app store-listing CRUD — the data the storefront renders on an
 * app's detail page (icon, screenshots, tagline, long description,
 * developer contact, social links, legal docs).
 *
 * Source of truth is the `app_listings` table (one row per app, lazily
 * created on first PUT). Owner-only writes; reads are owner-only here
 * because the storefront uses a separate public endpoint with a
 * deliberately curated subset of fields.
 *
 * Asset blobs (icon, screenshots, privacy/terms markdown) live in R2 at
 * `{appId}/_public/listing/...` and are uploaded via `/listing-assets/:kind`.
 * The listing row stores only their public URLs.
 */

export const listingsRoutes = new Hono<{ Bindings: Env }>();

/**
 * Public read for the storefront. No auth, no support email — that one's
 * private to the owner. Anyone hitting proappstore.online/apps/:id gets
 * this. Returns 404 only if the apps row doesn't exist; an apps row
 * without a listings row still returns the empty DTO so the storefront
 * can render a "this app hasn't filled in its listing yet" tile rather
 * than 404ing the page.
 */
listingsRoutes.get('/storefront/apps/:id', async (c) => {
  try {
    const appId = c.req.param('id');
    const appRow = await c.env.DB.prepare('SELECT id FROM apps WHERE id = ?')
      .bind(appId)
      .first<{ id: string }>();
    if (!appRow) return c.text('not found', 404);

    const row = await c.env.DB.prepare('SELECT * FROM app_listings WHERE app_id = ?')
      .bind(appId)
      .first<ListingRow>();
    const dto = row ? rowToDto(row) : emptyDto(appId);
    // Strip support_email from the public payload — it's owner-private,
    // exposed through supportUrl instead.
    const { supportEmail, ...publicDto } = dto;
    void supportEmail;
    // Short cache: lets edits propagate quickly while still absorbing
    // bursts from popular apps.
    c.header('Cache-Control', 'public, max-age=60');
    return c.json(publicDto);
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

/**
 * Public list of every app + its (partial) listing. Powers the storefront
 * homepage cards so the icon a dev uploads via Console actually surfaces
 * publicly. One round-trip instead of N per-app fetches; cached at the
 * edge for 60s like the single-app endpoint.
 *
 * Excludes support_email (owner-private). Includes `iconUrl`, `tagline`,
 * `category`, `themeColor` — enough for a card. Detail-page payloads still
 * come from /storefront/apps/:id when the user clicks through.
 */
listingsRoutes.get('/storefront/apps', async (c) => {
  try {
    const { results } = await c.env.DB.prepare(
      `SELECT a.id              AS app_id,
              l.icon_url,
              l.tagline,
              l.category,
              l.theme_color,
              l.updated_at
         FROM apps a
    LEFT JOIN app_listings l ON l.app_id = a.id
        ORDER BY a.created_at DESC`,
    ).all<{
      app_id: string;
      icon_url: string | null;
      tagline: string | null;
      category: string | null;
      theme_color: string | null;
      updated_at: number | null;
    }>();
    const apps = (results ?? []).map((r) => ({
      appId: r.app_id,
      iconUrl: r.icon_url,
      tagline: r.tagline,
      category: r.category,
      themeColor: r.theme_color,
      updatedAt: r.updated_at ?? 0,
    }));
    c.header('Cache-Control', 'public, max-age=60');
    return c.json({ apps });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

/** Owner read. */
listingsRoutes.get('/apps/:id/listing', async (c) => {
  try {
    const appId = c.req.param('id');
    await requireAppOwner(c, appId);
    const row = await c.env.DB.prepare('SELECT * FROM app_listings WHERE app_id = ?')
      .bind(appId)
      .first<ListingRow>();
    return c.json(row ? rowToDto(row) : emptyDto(appId));
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

/** Owner write. Merges in the provided fields; absent fields are unchanged. */
listingsRoutes.put('/apps/:id/listing', async (c) => {
  try {
    const appId = c.req.param('id');
    await requireAppOwner(c, appId);
    let body: ListingPatch;
    try {
      body = await c.req.json<ListingPatch>();
    } catch {
      return c.text('invalid JSON body', 400);
    }
    if (!body || typeof body !== 'object') return c.text('body must be a JSON object', 400);

    const patch: Partial<ListingRow> = {};
    if ('iconUrl' in body) patch.icon_url = urlOrNull(body.iconUrl);
    if ('themeColor' in body) patch.theme_color = hexOrNull(body.themeColor);
    if ('splashColor' in body) patch.splash_color = hexOrNull(body.splashColor);
    if ('tagline' in body) patch.tagline = clean(body.tagline, MAX_TAGLINE, 'tagline');
    if ('longDescription' in body) patch.long_description = clean(body.longDescription, MAX_LONG_DESC, 'longDescription');
    if ('category' in body) patch.category = clean(body.category, 40, 'category');
    if ('websiteUrl' in body) patch.website_url = urlOrNull(body.websiteUrl);
    if ('supportEmail' in body) patch.support_email = emailOrNull(body.supportEmail);
    if ('supportUrl' in body) patch.support_url = urlOrNull(body.supportUrl);
    if ('socialTwitter' in body) patch.social_twitter = handleOrNull(body.socialTwitter);
    if ('socialGithub' in body) patch.social_github = handleOrNull(body.socialGithub);
    if ('socialMastodon' in body) patch.social_mastodon = urlOrNull(body.socialMastodon);
    if ('socialBluesky' in body) {
      const raw = clean(body.socialBluesky, 128, 'socialBluesky');
      if (raw && !BLUESKY_HANDLE.test(raw.startsWith('@') ? raw.slice(1) : raw)) {
        throw new HttpError('invalid Bluesky handle (use the dot-form, e.g. alice.bsky.social)', 400);
      }
      patch.social_bluesky = raw ? (raw.startsWith('@') ? raw.slice(1) : raw) : null;
    }
    if ('privacyPolicyUrl' in body) patch.privacy_policy_url = urlOrNull(body.privacyPolicyUrl);
    if ('termsUrl' in body) patch.terms_url = urlOrNull(body.termsUrl);
    if ('screenshots' in body) {
      const arr = Array.isArray(body.screenshots) ? body.screenshots : [];
      const cleaned = arr
        .filter((s): s is string => typeof s === 'string' && URL_LIKE.test(s))
        .slice(0, MAX_SCREENSHOTS);
      patch.screenshots_json = JSON.stringify(cleaned);
    }

    const now = Date.now();
    // Upsert: insert the row if it doesn't exist, otherwise update only the
    // columns the patch touched. SQLite's INSERT ... ON CONFLICT lets us
    // express both in one statement, but the dynamic field set means we
    // build it programmatically.
    const cols = Object.keys(patch);
    if (cols.length === 0) {
      // No-op write — still bump updated_at so the dev gets feedback that
      // the call landed
      await c.env.DB.prepare(
        `INSERT INTO app_listings (app_id, updated_at) VALUES (?, ?)
         ON CONFLICT(app_id) DO UPDATE SET updated_at = excluded.updated_at`,
      )
        .bind(appId, now)
        .run();
    } else {
      const placeholders = cols.map(() => '?').join(', ');
      const updates = cols.map((c) => `${c} = excluded.${c}`).join(', ');
      const sql = `INSERT INTO app_listings (app_id, updated_at, ${cols.join(', ')})
                   VALUES (?, ?, ${placeholders})
                   ON CONFLICT(app_id) DO UPDATE SET ${updates}, updated_at = excluded.updated_at`;
      const values = [appId, now, ...cols.map((k) => (patch as Record<string, unknown>)[k])];
      await c.env.DB.prepare(sql).bind(...values).run();
    }

    const row = await c.env.DB.prepare('SELECT * FROM app_listings WHERE app_id = ?')
      .bind(appId)
      .first<ListingRow>();
    return c.json(row ? rowToDto(row) : emptyDto(appId));
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

/** Owner-only listing-asset upload. Returns the public URL. */
listingsRoutes.put('/apps/:id/listing-assets/:kind', async (c) => {
  try {
    const appId = c.req.param('id');
    const kind = c.req.param('kind');
    if (!ALLOWED_KINDS.has(kind) && !SCREENSHOT_KIND.test(kind)) {
      return c.text('invalid asset kind', 400);
    }
    await requireAppOwner(c, appId);

    const contentType = (c.req.header('Content-Type') ?? '').split(';')[0]!.trim().toLowerCase();
    const isMd = kind === 'privacy-policy' || kind === 'terms';
    const isScreenshot = SCREENSHOT_KIND.test(kind);

    if (isMd) {
      if (contentType !== 'text/markdown' && contentType !== 'text/plain') {
        return c.text('content-type must be text/markdown', 400);
      }
    } else {
      if (!IMAGE_TYPES.has(contentType)) {
        return c.text('content-type must be an image (png/jpeg/webp/svg)', 400);
      }
    }

    const body = await c.req.arrayBuffer();
    if (body.byteLength === 0) return c.text('empty body', 400);
    const max = isMd ? MAX_MD : isScreenshot ? MAX_SCREENSHOT : MAX_ICON;
    if (body.byteLength > max) {
      return c.text(`too large (max ${Math.floor(max / 1024)}KB)`, 413);
    }

    const ext = extFor(contentType);
    if (!ext) return c.text('unsupported content-type', 400);

    // Cache-bust by timestamping the path. The listing row stores the
    // returned URL so older versions are still reachable for any cached
    // storefront pages.
    const key = `${appId}/_public/listing/${kind}-${Date.now()}.${ext}`;
    await c.env.STORAGE.put(key, body, {
      httpMetadata: { contentType, cacheControl: 'public, max-age=31536000, immutable' },
    });

    const publicUrl = `${new URL(c.req.url).origin}/v1/apps/${appId}/public/listing/${key.slice(
      key.indexOf('_public/') + '_public/'.length,
    )}`;
    return c.json({ url: publicUrl, key, size: body.byteLength });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});
