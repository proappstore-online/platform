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
import { requireUser } from '../lib/auth.js';
import { openSecret, sealSecret } from '../lib/encryption.js';
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
  const internalToken = c.req.header('X-Internal-Token');
  const expected = c.env.INTERNAL_TOKEN;
  if (expected && internalToken && internalToken === expected) {
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
  const provider = c.req.query('provider') ?? '';
  const appId = c.req.query('app') ?? '';
  return c.html(renderKeysPage({ returnUrl, provider, appId }));
});

function renderKeysPage(opts: { returnUrl: string; provider: string; appId: string }): string {
  const { returnUrl, provider, appId } = opts;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>API Keys — ProAppStore</title>
  <style>
    :root { --accent: #7c3aed; --bg: #ffffff; --surface: #f8fafc; --ink: #0f172a; --muted: #64748b; --border: #e2e8f0; --danger: #dc2626; --success: #16a34a; }
    @media (prefers-color-scheme: dark) {
      :root { --bg: #0f172a; --surface: #1e293b; --ink: #f1f5f9; --muted: #94a3b8; --border: #334155; }
    }
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--ink); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; font-size: 15px; line-height: 1.5; }
    .wrap { max-width: 32rem; margin: 0 auto; padding: 2rem 1rem; }
    h1 { font-size: 1.5rem; font-weight: 800; margin: 0 0 0.25rem; }
    .sub { color: var(--muted); font-size: 0.85rem; margin-bottom: 1.5rem; }
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: 0.75rem; padding: 1rem; margin-bottom: 0.75rem; }
    .card h3 { margin: 0 0 0.25rem; font-size: 0.95rem; font-weight: 700; }
    .card .meta { font-size: 0.75rem; color: var(--muted); }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
    .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 9999px; font-size: 0.7rem; font-weight: 700; }
    .badge-on { background: #dcfce7; color: var(--success); }
    .badge-off { background: var(--surface); color: var(--muted); border: 1px solid var(--border); }
    input[type="password"], input[type="text"] { width: 100%; padding: 0.5rem 0.75rem; border: 1px solid var(--border); border-radius: 0.5rem; background: var(--bg); color: var(--ink); font-size: 0.85rem; font-family: inherit; margin: 0.5rem 0; }
    input:focus { outline: none; border-color: var(--accent); }
    .btn { display: inline-block; padding: 0.45rem 1rem; border: none; border-radius: 0.5rem; font-size: 0.85rem; font-weight: 600; cursor: pointer; font-family: inherit; }
    .btn-primary { background: var(--accent); color: #fff; }
    .btn-ghost { background: transparent; color: var(--ink); border: 1px solid var(--border); }
    .btn-danger { background: transparent; color: var(--danger); border: 1px solid var(--danger); }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .actions { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
    .alert { padding: 0.75rem 1rem; border-radius: 0.5rem; font-size: 0.85rem; margin-bottom: 1rem; }
    .alert-info { background: #f5f3ff; color: #6d28d9; border: 1px solid #c4b5fd; }
    .back { display: inline-block; margin-top: 1.5rem; color: var(--accent); text-decoration: none; font-size: 0.85rem; font-weight: 600; }
    .docs-link { font-size: 0.75rem; color: var(--accent); text-decoration: none; }
    #status { font-size: 0.8rem; color: var(--muted); margin-top: 0.5rem; }
    .hidden { display: none; }
  </style>
</head>
<body>
<div class="wrap">
  <h1>API Keys</h1>
  <p class="sub">Your keys are encrypted and stored on the ProAppStore platform. Apps and agents never see them — they're injected server-side when calls are made through the platform.</p>

  <div id="auth-gate" class="alert alert-info">Sign in to manage your API keys.</div>
  <div id="keys-list" class="hidden"></div>
  <div id="status"></div>

  ${returnUrl ? `<a class="back" href="${escapeAttr(returnUrl)}">Back to ${escapeAttr(appId || 'app')}</a>` : ''}
</div>
<script>
(function() {
  var API = '/v1';
  var token = null;
  var highlightProvider = ${JSON.stringify(provider)};

  // Get session token from localStorage. PAS identity rides on the FAS
  // session token, so accept either key.
  function getToken() {
    try {
      var stored = localStorage.getItem('pas_session') || localStorage.getItem('fas_session');
      if (stored) { var p = JSON.parse(stored); if (p && p.token) return p.token; }
    } catch (_) {}
    return null;
  }

  function headers() {
    return { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Accept': 'application/json' };
  }

  function setStatus(msg) { document.getElementById('status').textContent = msg; }

  async function load() {
    token = getToken();
    if (!token) return;
    document.getElementById('auth-gate').classList.add('hidden');
    document.getElementById('keys-list').classList.remove('hidden');

    var [provRes, statusRes] = await Promise.all([
      fetch(API + '/keys/providers', { headers: headers() }),
      fetch(API + '/keys/status', { headers: headers() }),
    ]);
    var providers = (await provRes.json()).providers || [];
    var existing = (await statusRes.json()).keys || [];
    var existingMap = {};
    existing.forEach(function(k) { existingMap[k.provider] = k; });

    var html = '';
    providers.forEach(function(p) {
      var has = !!existingMap[p.id];
      var highlight = p.id === highlightProvider ? ' style="border-color: var(--accent); box-shadow: 0 0 0 2px rgba(124,58,237,0.15);"' : '';
      html += '<div class="card" id="card-' + p.id + '"' + highlight + '>';
      html += '<div class="row"><div>';
      html += '<h3>' + esc(p.name) + '</h3>';
      if (p.docs_url) html += '<a class="docs-link" href="' + esc(p.docs_url) + '" target="_blank" rel="noopener">Get API key &#8599;</a>';
      html += '</div>';
      html += '<span class="badge ' + (has ? 'badge-on' : 'badge-off') + '">' + (has ? 'configured' : 'not set') + '</span>';
      html += '</div>';
      if (has) {
        html += '<p class="meta">Added ' + new Date(existingMap[p.id].created_at).toLocaleDateString() + '</p>';
        html += '<div class="actions">';
        html += '<button class="btn btn-ghost" onclick="editKey(\\''+p.id+'\\')">Update</button>';
        html += '<button class="btn btn-danger" onclick="deleteKey(\\''+p.id+'\\')">Remove</button>';
        html += '</div>';
      } else {
        html += '<div class="actions"><button class="btn btn-primary" onclick="editKey(\\''+p.id+'\\')">Add key</button></div>';
      }
      html += '<div id="form-' + p.id + '" class="hidden" style="margin-top:0.75rem">';
      html += '<input type="password" id="input-' + p.id + '" placeholder="Paste your ' + esc(p.name) + ' API key">';
      html += '<div class="actions">';
      html += '<button class="btn btn-primary" onclick="saveKey(\\''+p.id+'\\')">Save</button>';
      html += '<button class="btn btn-ghost" onclick="cancelEdit(\\''+p.id+'\\')">Cancel</button>';
      html += '</div></div>';
      html += '</div>';
    });
    document.getElementById('keys-list').innerHTML = html;

    if (highlightProvider) {
      var el = document.getElementById('card-' + highlightProvider);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  window.editKey = function(id) {
    document.getElementById('form-' + id).classList.remove('hidden');
    document.getElementById('input-' + id).focus();
  };
  window.cancelEdit = function(id) {
    document.getElementById('form-' + id).classList.add('hidden');
    document.getElementById('input-' + id).value = '';
  };
  window.saveKey = async function(id) {
    var val = document.getElementById('input-' + id).value.trim();
    if (!val) return;
    setStatus('Saving...');
    var res = await fetch(API + '/keys/' + id, { method: 'PUT', headers: headers(), body: JSON.stringify({ value: val }) });
    var data = await res.json();
    if (data.ok) { setStatus('Saved!'); load(); }
    else { setStatus('Error: ' + (data.error || 'unknown')); }
  };
  window.deleteKey = async function(id) {
    if (!confirm('Remove this API key?')) return;
    setStatus('Removing...');
    var res = await fetch(API + '/keys/' + id, { method: 'DELETE', headers: headers() });
    var data = await res.json();
    if (data.ok) { setStatus('Removed.'); load(); }
    else { setStatus('Error: ' + (data.error || 'unknown')); }
  };

  load();
})();
</script>
</body>
</html>`;
}

function escapeAttr(s: string): string {
  return s.replace(/[<>"'&]/g, (c) => `&#${c.charCodeAt(0)};`);
}
