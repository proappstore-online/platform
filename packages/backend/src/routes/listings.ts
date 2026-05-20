import { Hono } from 'hono';
import type { Env } from '../types.js';
import { requireAppOwner, HttpError } from '../lib/auth.js';

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

interface ListingRow {
  app_id: string;
  icon_url: string | null;
  theme_color: string | null;
  splash_color: string | null;
  tagline: string | null;
  long_description: string | null;
  category: string | null;
  website_url: string | null;
  support_email: string | null;
  support_url: string | null;
  social_twitter: string | null;
  social_github: string | null;
  social_mastodon: string | null;
  social_bluesky: string | null;
  privacy_policy_url: string | null;
  terms_url: string | null;
  screenshots_json: string;
  updated_at: number;
}

export interface ListingDto {
  appId: string;
  iconUrl: string | null;
  themeColor: string | null;
  splashColor: string | null;
  tagline: string | null;
  longDescription: string | null;
  category: string | null;
  websiteUrl: string | null;
  supportEmail: string | null;
  supportUrl: string | null;
  socialTwitter: string | null;
  socialGithub: string | null;
  socialMastodon: string | null;
  socialBluesky: string | null;
  privacyPolicyUrl: string | null;
  termsUrl: string | null;
  screenshots: string[];
  updatedAt: number;
}

const HEX = /^#[0-9a-fA-F]{3,8}$/;
const URL_LIKE = /^https?:\/\/.+/i;
const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HANDLE = /^[a-zA-Z0-9._-]{1,64}$/;

const MAX_TAGLINE = 60;
const MAX_LONG_DESC = 5000;
const MAX_SCREENSHOTS = 8;

function rowToDto(r: ListingRow): ListingDto {
  let screenshots: string[] = [];
  try {
    const parsed = JSON.parse(r.screenshots_json);
    if (Array.isArray(parsed)) screenshots = parsed.filter((s): s is string => typeof s === 'string');
  } catch {
    // bad JSON — return empty rather than 500
  }
  return {
    appId: r.app_id,
    iconUrl: r.icon_url,
    themeColor: r.theme_color,
    splashColor: r.splash_color,
    tagline: r.tagline,
    longDescription: r.long_description,
    category: r.category,
    websiteUrl: r.website_url,
    supportEmail: r.support_email,
    supportUrl: r.support_url,
    socialTwitter: r.social_twitter,
    socialGithub: r.social_github,
    socialMastodon: r.social_mastodon,
    socialBluesky: r.social_bluesky,
    privacyPolicyUrl: r.privacy_policy_url,
    termsUrl: r.terms_url,
    screenshots,
    updatedAt: r.updated_at,
  };
}

function emptyDto(appId: string): ListingDto {
  return {
    appId,
    iconUrl: null,
    themeColor: null,
    splashColor: null,
    tagline: null,
    longDescription: null,
    category: null,
    websiteUrl: null,
    supportEmail: null,
    supportUrl: null,
    socialTwitter: null,
    socialGithub: null,
    socialMastodon: null,
    socialBluesky: null,
    privacyPolicyUrl: null,
    termsUrl: null,
    screenshots: [],
    updatedAt: 0,
  };
}

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
    if (err instanceof HttpError) return c.text(err.message, err.status as 401);
    throw err;
  }
});

interface ListingPatch {
  iconUrl?: string | null;
  themeColor?: string | null;
  splashColor?: string | null;
  tagline?: string | null;
  longDescription?: string | null;
  category?: string | null;
  websiteUrl?: string | null;
  supportEmail?: string | null;
  supportUrl?: string | null;
  socialTwitter?: string | null;
  socialGithub?: string | null;
  socialMastodon?: string | null;
  socialBluesky?: string | null;
  privacyPolicyUrl?: string | null;
  termsUrl?: string | null;
  screenshots?: string[];
}

function clean(v: unknown, max?: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  return max && s.length > max ? s.slice(0, max) : s;
}

function urlOrNull(v: unknown): string | null {
  const s = clean(v);
  if (!s) return null;
  if (!URL_LIKE.test(s)) throw new HttpError('invalid URL', 400);
  return s;
}

function emailOrNull(v: unknown): string | null {
  const s = clean(v);
  if (!s) return null;
  if (!EMAIL_LIKE.test(s)) throw new HttpError('invalid email', 400);
  return s;
}

function hexOrNull(v: unknown): string | null {
  const s = clean(v);
  if (!s) return null;
  if (!HEX.test(s)) throw new HttpError('invalid color (must be #RRGGBB)', 400);
  return s;
}

function handleOrNull(v: unknown): string | null {
  const s = clean(v);
  if (!s) return null;
  // Strip a leading @ if the user pasted one
  const stripped = s.startsWith('@') ? s.slice(1) : s;
  if (!HANDLE.test(stripped)) throw new HttpError('invalid handle', 400);
  return stripped;
}

/** Owner write. Merges in the provided fields; absent fields are unchanged. */
listingsRoutes.put('/apps/:id/listing', async (c) => {
  try {
    const appId = c.req.param('id');
    await requireAppOwner(c, appId);
    const body = await c.req.json<ListingPatch>();

    const patch: Partial<ListingRow> = {};
    if ('iconUrl' in body) patch.icon_url = urlOrNull(body.iconUrl);
    if ('themeColor' in body) patch.theme_color = hexOrNull(body.themeColor);
    if ('splashColor' in body) patch.splash_color = hexOrNull(body.splashColor);
    if ('tagline' in body) patch.tagline = clean(body.tagline, MAX_TAGLINE);
    if ('longDescription' in body) patch.long_description = clean(body.longDescription, MAX_LONG_DESC);
    if ('category' in body) patch.category = clean(body.category, 40);
    if ('websiteUrl' in body) patch.website_url = urlOrNull(body.websiteUrl);
    if ('supportEmail' in body) patch.support_email = emailOrNull(body.supportEmail);
    if ('supportUrl' in body) patch.support_url = urlOrNull(body.supportUrl);
    if ('socialTwitter' in body) patch.social_twitter = handleOrNull(body.socialTwitter);
    if ('socialGithub' in body) patch.social_github = handleOrNull(body.socialGithub);
    if ('socialMastodon' in body) patch.social_mastodon = urlOrNull(body.socialMastodon);
    if ('socialBluesky' in body) patch.social_bluesky = clean(body.socialBluesky, 128);
    if ('privacyPolicyUrl' in body) patch.privacy_policy_url = urlOrNull(body.privacyPolicyUrl);
    if ('terms_url' in body || 'termsUrl' in body) patch.terms_url = urlOrNull(body.termsUrl);
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
    if (err instanceof HttpError) return c.text(err.message, err.status as 401);
    throw err;
  }
});

const ALLOWED_KINDS = new Set(['icon', 'privacy-policy', 'terms']);
const SCREENSHOT_KIND = /^screenshot-[0-7]$/;

const MAX_ICON = 5 * 1024 * 1024;
const MAX_SCREENSHOT = 8 * 1024 * 1024;
const MAX_MD = 200 * 1024;

const IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/svg+xml',
]);

function extFor(contentType: string): string | null {
  return {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'text/markdown': 'md',
    'text/plain': 'md',
  }[contentType.toLowerCase()] ?? null;
}

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
    if (err instanceof HttpError) return c.text(err.message, err.status as 401);
    throw err;
  }
});
