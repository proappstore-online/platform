/**
 * Server-rendered HTML for the API Key Vault management page (GET /v1/keys).
 *
 * Extracted verbatim from routes/keys.ts. Returns the full HTML document as a
 * string (including its embedded browser-side <script> snippet). The page lets
 * a signed-in user add/update/remove their encrypted per-provider API keys via
 * the /v1/keys/* JSON endpoints.
 */

export function renderKeysPage(opts: { returnUrl: string; provider: string; appId: string }): string {
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

  function getToken() {
    try {
      var stored = localStorage.getItem('pas_session');
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
