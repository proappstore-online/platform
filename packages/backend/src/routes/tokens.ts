/**
 * Personal app tokens (#154): mint, list and revoke your own `pas_at_` tokens
 * for one app, plus a cross-app listing for the dashboard. Session-authed only —
 * `requireUser` verifies a session JWT and nothing else, so a token can never
 * manage tokens.
 */
import { Hono } from 'hono';
import type { Env } from '../types.js';
import { HttpError, requireUser } from '../lib/auth.js';
import { isFirstPartyHost } from './auth.js';
import {
  ACTION_NAME_RE,
  MAX_SCOPED_ACTIONS,
  MAX_TTL_APP_ORIGIN_SECONDS,
  MAX_TTL_FIRST_PARTY_SECONDS,
  MIN_TTL_SECONDS,
  mintTokenId,
  mintTokenString,
  parseScopes,
  sha256Hex,
  type TokenScopes,
} from '../lib/app-tokens.js';

export const tokenRoutes = new Hono<{ Bindings: Env }>();

interface TokenListRow {
  token_id: string;
  app_id: string;
  label: string | null;
  scopes: string;
  created_origin: string | null;
  created_at: number;
  last_used_at: number | null;
  expires_at: number;
}

const LIST_COLUMNS = 'token_id, app_id, label, scopes, created_origin, created_at, last_used_at, expires_at';

function view(row: TokenListRow) {
  const scopes = parseScopes(row.scopes);
  return {
    token_id: row.token_id,
    app_id: row.app_id,
    label: row.label,
    access: scopes.access,
    actions: scopes.actions,
    created_origin: row.created_origin,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    expires_at: row.expires_at,
    expired: row.expires_at <= Date.now(),
  };
}

/** The Origin header's host, or null when the request carries none (a non-browser caller). */
function originHost(origin: string | undefined): string | null {
  if (!origin) return null;
  try { return new URL(origin).hostname; } catch { return origin; }
}

// ── POST /v1/apps/:appId/tokens — mint (plaintext returned once) ──
tokenRoutes.post('/apps/:appId/tokens', async (c) => {
  const appId = c.req.param('appId')!;
  const user = await requireUser(c);
  if (!/^[a-z][a-z0-9-]*$/.test(appId) || appId.length > 58) throw new HttpError('invalid app id', 400);
  const body = await c.req.json<{ label?: unknown; expires_in?: unknown; access?: unknown; actions?: unknown }>().catch(() => null);
  if (!body || typeof body !== 'object') throw new HttpError('JSON body required', 400);

  // access is required — nobody mints an all-powerful token by omission (#154 amendment).
  if (body.access !== 'read' && body.access !== 'write') throw new HttpError('access is required: "read" or "write"', 400);
  if (typeof body.expires_in !== 'number' || !Number.isInteger(body.expires_in) || body.expires_in < MIN_TTL_SECONDS) {
    throw new HttpError(`expires_in (seconds) is required and must be at least ${MIN_TTL_SECONDS}`, 400);
  }
  const label = body.label === undefined || body.label === null ? null : String(body.label).slice(0, 80);

  let actions: string[] | null = null;
  if (body.actions !== undefined && body.actions !== null) {
    if (!Array.isArray(body.actions) || body.actions.length === 0 || body.actions.length > MAX_SCOPED_ACTIONS) {
      throw new HttpError(`actions must be a non-empty array of at most ${MAX_SCOPED_ACTIONS} names`, 400);
    }
    for (const a of body.actions) {
      if (typeof a !== 'string' || !ACTION_NAME_RE.test(a)) throw new HttpError('actions must be action names (lowercase, digits, underscores)', 400);
    }
    actions = [...new Set(body.actions as string[])];
  }

  const app = await c.env.DB.prepare('SELECT id FROM apps WHERE id = ?').bind(appId).first<{ id: string }>();
  if (!app) throw new HttpError('app not found', 404);

  if (actions) {
    // A typo fails loudly at mint; an action removed later leaves a harmless stale entry.
    const placeholders = actions.map(() => '?').join(', ');
    const rows = await c.env.DB.prepare(`SELECT name FROM app_tools WHERE app_id = ? AND name IN (${placeholders})`)
      .bind(appId, ...actions).all<{ name: string }>();
    const known = new Set((rows.results ?? []).map((r) => r.name));
    const missing = actions.filter((a) => !known.has(a));
    if (missing.length) throw new HttpError(`unknown action: ${missing.join(', ')}`, 400);
  }

  // A browser origin that is not first-party is creator-controlled JS (#56): its
  // tokens live at most 90 days. No token is ever non-expiring.
  const host = originHost(c.req.header('Origin'));
  const cap = host === null || isFirstPartyHost(host) ? MAX_TTL_FIRST_PARTY_SECONDS : MAX_TTL_APP_ORIGIN_SECONDS;
  const ttl = Math.min(body.expires_in, cap);

  const token = mintTokenString();
  const tokenId = mintTokenId();
  const now = Date.now();
  const expiresAt = now + ttl * 1000;
  const scopes: TokenScopes = { access: body.access, actions };
  await c.env.DB.prepare(
    'INSERT INTO user_app_tokens (token_hash, token_id, user_id, app_id, label, scopes, created_origin, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(await sha256Hex(token), tokenId, user.id, appId, label, JSON.stringify(scopes), host, now, expiresAt).run();

  return c.json({
    token,
    token_id: tokenId,
    app_id: appId,
    label,
    access: scopes.access,
    actions,
    created_origin: host,
    created_at: now,
    expires_at: expiresAt,
    ...(ttl < body.expires_in ? { note: `expires_in capped at ${cap} seconds for this origin` } : {}),
  }, 201);
});

// ── GET /v1/apps/:appId/tokens — my tokens for this app (never the token) ──
tokenRoutes.get('/apps/:appId/tokens', async (c) => {
  const appId = c.req.param('appId')!;
  const user = await requireUser(c);
  const rows = await c.env.DB.prepare(
    `SELECT ${LIST_COLUMNS} FROM user_app_tokens WHERE app_id = ? AND user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 200`,
  ).bind(appId, user.id).all<TokenListRow>();
  c.header('Cache-Control', 'private, no-store');
  return c.json({ tokens: (rows.results ?? []).map(view) });
});

// ── GET /v1/me/tokens — every token I hold, across apps (dashboard) ──
tokenRoutes.get('/me/tokens', async (c) => {
  const user = await requireUser(c);
  const rows = await c.env.DB.prepare(
    `SELECT ${LIST_COLUMNS} FROM user_app_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 500`,
  ).bind(user.id).all<TokenListRow>();
  c.header('Cache-Control', 'private, no-store');
  return c.json({ tokens: (rows.results ?? []).map(view) });
});

// ── DELETE /v1/apps/:appId/tokens/:tokenId — revoke one of mine ──
// Exact match on id + user + app: another user's token id, or a wildcard-shaped
// path, is simply not found.
tokenRoutes.delete('/apps/:appId/tokens/:tokenId', async (c) => {
  const appId = c.req.param('appId')!;
  const tokenId = c.req.param('tokenId')!;
  const user = await requireUser(c);
  const result = await c.env.DB.prepare(
    'UPDATE user_app_tokens SET revoked_at = ? WHERE token_id = ? AND user_id = ? AND app_id = ? AND revoked_at IS NULL',
  ).bind(Date.now(), tokenId, user.id, appId).run();
  if (!result.meta?.changes) throw new HttpError('token not found', 404);
  return c.json({ ok: true });
});
