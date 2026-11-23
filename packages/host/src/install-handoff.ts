/**
 * Near-one-tap install for the Android companion's "Open {app}" (#628 part A).
 *
 * The companion opens `https://<id>.proappstore.online/?install=1`. Only then
 * does the page get `<script src="/.pas/install.js" defer>` before `</head>`;
 * without the parameter the HTML is unchanged. The script shows an Install bar
 * when Chrome fires `beforeinstallprompt`, and nothing otherwise.
 *
 * Served from the host rather than the SDK because the host serves every app
 * (half the catalogue has no `AppShell`, and none of it shows an install
 * prompt to a signed-out visitor). Same-origin `src`, like `/.pas/analytics.js`
 * (#402), so an app's own meta CSP that pins `'self'` still runs it. Wired after
 * the private-app gate, so a private app serves it only to people it admits.
 */
export const INSTALL_SCRIPT_PATH = "/.pas/install.js";
export const INSTALL_SCRIPT_TAG = `<script src="${INSTALL_SCRIPT_PATH}" defer></script>`;

/**
 * Plain ES2019, no dependencies. Its only request is a read of the page's own
 * same-origin manifest for the label. Inside a closed shadow root, so the app's
 * CSS cannot break it and it cannot break the app. Tokens are the SDK shell's
 * (`--accent`, `--panel`, `--ink`, `--line`) with fallbacks.
 */
export const INSTALL_SCRIPT = `(function () {
  var u = new URL(location.href);
  if (u.searchParams.get('install') === '1') { u.searchParams.delete('install'); history.replaceState(history.state, '', u.href); }
  if (matchMedia('(display-mode: standalone)').matches || navigator.standalone) return;
  if (!('onbeforeinstallprompt' in window)) return;
  var deferred = null, host = null;
  function close() { if (host) host.remove(); host = null; deferred = null; }
  function label() {
    var link = document.querySelector('link[rel="manifest"]');
    var href = link && link.href ? new URL(link.href, location.href) : null;
    if (!href || href.origin !== location.origin) return Promise.resolve('Install app');
    return fetch(href.href, { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (m) {
        var name = m && (m.short_name || m.name);
        return typeof name === 'string' && name.trim() ? 'Install ' + name.trim().slice(0, 40) : 'Install app';
      })
      .catch(function () { return 'Install app'; });
  }
  function show() {
    label().then(function (text) {
      if (host || !deferred) return;
      host = document.createElement('div');
      var root = host.attachShadow({ mode: 'closed' });
      root.innerHTML = '<style>' +
        '.bar{position:fixed;inset-inline:16px;bottom:calc(16px + env(safe-area-inset-bottom));z-index:2147483647;display:flex;gap:8px;align-items:center;' +
        'padding:8px;border-radius:14px;background:var(--panel,#fff);color:var(--ink,#111827);border:1px solid var(--line,#e5e7eb);' +
        'box-shadow:0 8px 24px rgba(0,0,0,.18);font:600 16px/1.2 system-ui,-apple-system,sans-serif}' +
        'button{min-height:44px;border-radius:10px;font:inherit;cursor:pointer;padding:0 16px}' +
        '.install{flex:1;border:0;background:var(--accent,#7c3aed);color:#fff}' +
        '.later{border:1px solid var(--line,#e5e7eb);background:transparent;color:inherit}' +
        '</style><div class="bar" role="region" aria-label="Install this app"><button class="install" type="button"></button><button class="later" type="button">Not now</button></div>';
      root.querySelector('.install').textContent = text;
      root.querySelector('.install').addEventListener('click', function () {
        var event = deferred;
        deferred = null;
        if (!event) return close();
        try {
          Promise.resolve(event.prompt()).then(function () { return event.userChoice; }).then(close, close);
        } catch (e) { close(); }
      });
      root.querySelector('.later').addEventListener('click', close);
      document.body.appendChild(host);
    });
  }
  addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferred = e; show(); }, { once: true });
  addEventListener('appinstalled', close);
})();
`;

/** `GET|HEAD /.pas/install.js`: the same static script for every app. Null for any other path. */
export function handleInstallHandoff(request: Request): Response | null {
  if (new URL(request.url).pathname !== INSTALL_SCRIPT_PATH) return null;
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response("Method not allowed", { status: 405 });
  return new Response(request.method === "HEAD" ? null : INSTALL_SCRIPT, {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** Only the exact `?install=1` asks for the script. */
export function wantsInstallHandoff(url: URL): boolean {
  return url.searchParams.get("install") === "1";
}

/**
 * Puts the script tag immediately before `</head>`, like `HeadEndInjector` in meta-rewriter.ts, or at the end of a
 * document without a `</head>` (HTMLRewriter streams tokens and never synthesises an implied head).
 */
export function injectInstallHandoff(response: Response): Response {
  let injected = false;
  return new HTMLRewriter()
    .on("head", {
      element(el: Element) {
        el.onEndTag((end) => {
          if (injected) return;
          injected = true;
          end.before(INSTALL_SCRIPT_TAG, { html: true });
        });
      },
    })
    .onDocument({
      end(end) {
        if (!injected) end.append(INSTALL_SCRIPT_TAG, { html: true });
      },
    })
    .transform(response);
}
