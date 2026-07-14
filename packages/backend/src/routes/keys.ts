/**
 * User API Key Vault — encrypted per-user API keys for third-party services.
 * Vendored from FAS (routes/keys.ts). PAS owns this copy.
 *
 * Keys are managed on a platform-hosted page (GET /v1/keys), not inside
 * individual apps. They are encrypted with envelope encryption (same KEK as
 * app_secrets) and never returned to app clients.
 *
 * The PAS Agent Teams worker resolves a user's BYO LLM key via the internal
 * /v1/keys/resolve/:provider endpoint over the PAS_BACKEND service binding —
 * authenticated with INTERNAL_TOKEN + X-Owner-Id (so the autonomous loop works
 * without a live user session), or with a normal user bearer token.
 *
 * API routes:
 *   GET    /v1/keys                 → HTML key management page (or JSON if Accept: application/json)
 *   GET    /v1/keys/providers       → list of supported providers
 *   GET    /v1/keys/status          → which providers the user has keys for
 *   GET    /v1/keys/usage           → daily proxy usage for the user's keys
 *   PUT    /v1/keys/:provider       → store (or update) an encrypted key
 *   DELETE /v1/keys/:provider       → delete a stored key
 *   GET    /v1/keys/resolve/:provider → internal: decrypt + return a key (service binding)
 */

import { Hono } from 'hono';
import { internalTokenOk } from '@proappstore/build-core';
import { requireUser } from '../lib/auth.js';
import { openSecret, sealSecret } from '../lib/encryption.js';
import { renderKeysPage } from './keys-page.js';
import type { Env } from '../types.js';

type AppEnv = { Bindings: Env };

export const keysRoutes = new Hono<AppEnv>();

// ── Providers list (public, no auth) ──────────────────────────────────

keysRoutes.get('/keys/providers', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT id, name, docs_url, key_prefix FROM key_providers ORDER BY name',
  ).all<{ id: string; name: string; docs_url: string | null; key_prefix: string | null }>();
  return c.json({ providers: rows.results });
});

// ── Key status (which providers user has keys for) ────────────────────

keysRoutes.get('/keys/status', async (c) => {
  const user = await requireUser(c);
  const rows = await c.env.DB.prepare(
    'SELECT provider, label, created_at, last_used_at FROM user_api_keys WHERE user_id = ?',
  )
    .bind(user.id)
    .all<{
      provider: string;
      label: string | null;
      created_at: number;
      last_used_at: number | null;
    }>();
  return c.json({
    keys: rows.results.map((r) => ({
      provider: r.provider,
      label: r.label,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
    })),
  });
});

// ── Usage (daily proxy calls via user keys) ──────────────────────────

keysRoutes.get('/keys/usage', async (c) => {
  const user = await requireUser(c);
  const today = new Date().toISOString().slice(0, 10);
  const row = await c.env.DB.prepare(
    'SELECT count FROM app_proxy_usage WHERE app_id = ? AND day = ?',
  )
    .bind(`userkey:${user.id}`, today)
    .first<{ count: number }>();
  return c.json({ used: row?.count ?? 0, limit: 1000, day: today });
});

// ── Store / update a key ──────────────────────────────────────────────

keysRoutes.put('/keys/:provider', async (c) => {
  const user = await requireUser(c);
  if (!c.env.APP_SECRET_KEK) {
    return c.json({ ok: false, error: 'Key vault not configured (APP_SECRET_KEK missing).' }, 503);
  }

  const provider = c.req.param('provider');
  const body = await c.req.json<{ value: string; label?: string }>();
  if (!body.value || typeof body.value !== 'string' || body.value.length > 500) {
    return c.json({ ok: false, error: 'Invalid key value (max 500 chars).' }, 400);
  }

  // Validate provider exists
  const prov = await c.env.DB.prepare('SELECT id, key_prefix FROM key_providers WHERE id = ?')
    .bind(provider)
    .first<{ id: string; key_prefix: string | null }>();
  if (!prov) {
    return c.json({ ok: false, error: `Unknown provider: ${provider}` }, 400);
  }

  // Optional prefix validation
  if (prov.key_prefix && !body.value.startsWith(prov.key_prefix)) {
    return c.json(
      {
        ok: false,
        error: `Key should start with "${prov.key_prefix}". Check you copied the full key.`,
      },
      400,
    );
  }

  const sealed = await sealSecret(body.value, c.env.APP_SECRET_KEK);
  await c.env.DB.prepare(
    `INSERT INTO user_api_keys (user_id, provider, label, key_ciphertext, dek_wrapped, iv, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, provider) DO UPDATE SET
       label = excluded.label,
       key_ciphertext = excluded.key_ciphertext,
       dek_wrapped = excluded.dek_wrapped,
       iv = excluded.iv`,
  )
    .bind(
      user.id,
      provider,
      body.label ?? null,
      sealed.keyCiphertext,
      sealed.dekWrapped,
      sealed.iv,
      Date.now(),
    )
    .run();

  return c.json({ ok: true });
});

// ── Delete a key ──────────────────────────────────────────────────────

keysRoutes.delete('/keys/:provider', async (c) => {
  const user = await requireUser(c);

  const provider = c.req.param('provider');
  const result = await c.env.DB.prepare(
    'DELETE FROM user_api_keys WHERE user_id = ? AND provider = ?',
  )
    .bind(user.id, provider)
    .run();

  return c.json({ ok: true, removed: (result.meta?.changes ?? 0) > 0 });
});

// ── Internal key resolve (for the agent-teams service binding) ─────────
// Called by the PAS Agent Teams worker via the PAS_BACKEND service binding to
// fetch a user's decrypted BYO key for an autonomous agent run. Authenticated
// two ways:
//   1. INTERNAL_TOKEN + X-Owner-Id  → autonomous path (no live user session)
//   2. user bearer token            → interactive path
// Never log the returned plaintext. The key only ever travels worker→worker.

keysRoutes.get('/keys/resolve/:provider', async (c) => {
  const provider = c.req.param('provider');

  let userId: string;
  if (internalTokenOk(c.req.header('X-Internal-Token'), c.env.INTERNAL_TOKEN)) {
    const ownerId = c.req.header('X-Owner-Id');
    if (!ownerId) return c.json({ key: null, error: 'X-Owner-Id required for internal resolve' }, 400);
    userId = ownerId;
  } else {
    // Fall back to a normal user session; reject if neither auth mode is present.
    const user = await requireUser(c);
    userId = user.id;
  }

  if (!c.env.APP_SECRET_KEK) {
    return c.json({ key: null, error: 'vault not configured' }, 503);
  }

  const key = await resolveUserKey(c.env.DB, userId, provider, c.env.APP_SECRET_KEK);
  if (!key) return c.json({ key: null });
  return c.json({ key });
});

// ── Resolve a user's key (internal, also used by the proxy) ────────────

export async function resolveUserKey(
  db: D1Database,
  userId: string,
  provider: string,
  kek: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      'SELECT key_ciphertext, dek_wrapped, iv FROM user_api_keys WHERE user_id = ? AND provider = ?',
    )
    .bind(userId, provider)
    .first<{ key_ciphertext: ArrayBuffer; dek_wrapped: ArrayBuffer; iv: ArrayBuffer }>();

  if (!row) return null;

  const plaintext = await openSecret(
    {
      keyCiphertext: new Uint8Array(row.key_ciphertext),
      dekWrapped: new Uint8Array(row.dek_wrapped),
      iv: new Uint8Array(row.iv),
    },
    kek,
  );

  // Probabilistic last_used_at update (1 in 10)
  if (Math.random() < 0.1) {
    await db
      .prepare('UPDATE user_api_keys SET last_used_at = ? WHERE user_id = ? AND provider = ?')
      .bind(Date.now(), userId, provider)
      .run()
      .catch(() => {});
  }

  return plaintext;
}

// ── Key management page (server-rendered HTML) ────────────────────────

keysRoutes.get('/keys', async (c) => {
  const accept = c.req.header('accept') ?? '';
  if (accept.includes('application/json')) {
    const user = await requireUser(c);
    const rows = await c.env.DB.prepare(
      'SELECT provider, label, created_at, last_used_at FROM user_api_keys WHERE user_id = ?',
    )
      .bind(user.id)
      .all<{
        provider: string;
        label: string | null;
        created_at: number;
        last_used_at: number | null;
      }>();
    return c.json({ keys: rows.results });
  }

  const returnUrl = c.req.query('return') ?? '';
  // Provider is a known slug (openai/anthropic/…). This page is UNAUTHENTICATED
  // and embeds `provider` inside an inline <script> via JSON.stringify, which
  // does NOT escape '/', so an unvalidated value like `</script><img onerror=…>`
  // breaks out and can steal the localStorage session token. Strip to a safe
  // slug charset so nothing HTML/script-significant can survive.
  const provider = (c.req.query('provider') ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
  const appId = c.req.query('app') ?? '';
  return c.html(renderKeysPage({ returnUrl, provider, appId }));
});
