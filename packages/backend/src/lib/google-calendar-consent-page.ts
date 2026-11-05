import type { Context } from 'hono';
import { html, raw } from 'hono/html';
import type { Env } from '../types.js';
import type { OAuthState } from './google-calendar-oauth.js';
import { randomState } from './google-calendar-common.js';
import { googleCapabilities, googleDisclosure } from './google-calendar-policy.js';

type Ctx = Context<{ Bindings: Env }>;

const styles = `:root{color-scheme:light dark;font-family:system-ui,sans-serif;line-height:1.5;overflow-wrap:anywhere}
*{box-sizing:border-box}
body{margin:0;padding:20px;background:light-dark(#f8fafc,#111827);color:light-dark(#172033,#f3f4f6)}
main{max-width:36rem;margin:24px auto}
h1{font-size:1.65rem;line-height:1.2}
h2{font-size:1rem;margin:22px 0 4px}
p{margin:8px 0}
a{color:light-dark(#1d4ed8,#93c5fd)}
label{display:block;margin:12px 0}
input:not([type=checkbox]){width:100%;font:inherit;padding:10px;border:1px solid #94a3b8;border-radius:8px}
input[type=checkbox]{width:20px;height:20px;vertical-align:middle;margin-right:8px}
button,.button{display:inline-block;min-height:44px;padding:11px 16px;font:inherit;border:0;border-radius:8px;background:#2563eb;color:white;text-decoration:none;cursor:pointer;margin:8px 6px 0 0}
.secondary{background:light-dark(#e2e8f0,#334155);color:inherit}
.card{padding:16px;border:1px solid #94a3b8;border-radius:12px;margin:16px 0}
.muted{font-size:.9rem;color:light-dark(#475569,#cbd5e1)}
[role=alert]{color:light-dark(#991b1b,#fca5a5)}
form{margin-top:16px}
footer{font-size:.9rem;margin-top:24px}
`;
const credentialScript = `
document.querySelector('#credentials')?.addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const error = document.querySelector('[role=alert]');
  const button = form.querySelector('button');
  const password = form.querySelector('[name=password]');
  const data = new FormData(form);
  let failureMessage = 'Could not sign in. Try again.';
  error.textContent = '';
  button.disabled = true;
  try {
    const response = await fetch('/v1/auth/credentials/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: data.get('login'), password: data.get('password') }),
    });
    const result = await response.json();
    if (!response.ok || !result.token) {
      failureMessage = 'Sign-in failed. Check your details and try again.';
      throw Error();
    }
    const bound = await fetch(form.dataset.session, {
      method: 'POST', headers: { Authorization: 'Bearer ' + result.token },
    });
    if (!bound.ok) {
      failureMessage = 'Sign in with the same ProAppStore account that started this connection.';
      throw Error();
    }
    location.reload();
  } catch {
    error.textContent = failureMessage;
  } finally {
    password.value = '';
    button.disabled = false;
  }
});`;
export function googleConsentPage(c: Ctx, body: ReturnType<typeof html>, script = '') {
  const nonce = randomState();
  c.header('Content-Security-Policy', `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'; base-uri 'none'`);
  return c.html(html`<!doctype html>
      <html lang="en">
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Google · ProAppStore</title><style nonce="${nonce}">${raw(styles)}</style></head><body><main><a href="https://proappstore.online/">ProAppStore</a>${body}<footer><a href="https://proappstore.online/privacy#google-data" target="_blank" rel="noopener noreferrer">Platform privacy</a></footer></main>${script ? html`<script nonce="${nonce}">${raw(script)}</script>` : ''}</body></html>`);
}

export function googleSignInPage(c: Ctx, { pending, name, signIn, sessionUrl }: {
  pending: OAuthState; name: string; signIn: { google: string; github: string }; sessionUrl: string;
}) {
  return googleConsentPage(c, html`<h1>Connect Google to ${name}</h1>
      <p class="muted">${new URL(pending.callback_url).origin}</p>
      <p>First, confirm the ProAppStore account you used in the app.</p>
      <a class="button" href="${signIn.google}">Sign in with Google</a><a class="button secondary" href="${signIn.github}">Sign in with GitHub</a><details><summary>Use email or username</summary><form id="credentials" method="post" action="/v1/auth/credentials/login" data-session="${sessionUrl}"><label>Email or username<input name="login" autocomplete="username" required></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
      <button>Sign in</button></form>
      <p role="alert"></p>
      </details>
      <p class="muted">Google access is optional. No access is granted by opening this page.</p>`, credentialScript);
}

export function googleAccessPage(c: Ctx, { pending, name, action, csrf, shared }: {
  pending: OAuthState; name: string; action: string; csrf: string;
  shared: { status: string; email: string | null; version: number } | null;
}) {
  const disclosure = googleDisclosure(JSON.parse(pending.disclosure_json!));
  const capabilities = googleCapabilities(JSON.parse(pending.capabilities_json));
  const changeAccount = shared?.status === 'connected' ? html`<details><summary>Use a different Google account</summary><p>Google is currently connected as ${shared.email}. Changing this shared account first disconnects Google from every Pro app.</p>
      <form method="post" action="${action}"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="decision" value="disconnect_all"><input type="hidden" name="expected_version" value="${shared.version}"><label><input type="checkbox" name="confirm_global" value="yes" required>Disconnect Google for all of my apps</label>
      <button class="secondary">Disconnect all apps</button></form>
      </details>` : '';
  return googleConsentPage(c, html`<h1>Connect Google to ${name}</h1>
      <p class="muted">${new URL(pending.callback_url).origin}</p>
      <p>${disclosure.purpose}</p>
      <form method="post" action="${action}"><input type="hidden" name="csrf" value="${csrf}"><div class="card">
      <h2>Choose access</h2><label><input type="checkbox" name="capability" value="calendar.read" checked required>Read calendars and events</label>
      <p class="muted">List calendars so you can select one, then read its meeting titles, times and links. No editing.</p>${capabilities.includes('meet.read') ? html`<label><input type="checkbox" name="capability" value="meet.read" checked>Read related Google Meet records</label>
      <p class="muted">Participant identities and names, conference times, and join/leave sessions. Meet data must not be collected for performance tracking or user evaluation.</p>` : ''}</div>
      <h2>Who can see the data</h2><p>${disclosure.audience}</p>
      <h2>How long it is kept</h2><p>${disclosure.retention}</p>
      <p><a href="${new URL(disclosure.privacy_path, pending.callback_url).href}" target="_blank" rel="noopener noreferrer">App privacy</a> · <a href="${new URL(disclosure.deletion_path, pending.callback_url).href}" target="_blank" rel="noopener noreferrer">Delete saved app data</a></p>
      <p class="muted">PAS keeps encrypted Google credentials. This app receives only the access you choose. Disconnecting stops future reads; it does not erase records the app already saved. Connecting this app will not disconnect your other apps.</p>
      <button name="decision" value="allow">Continue to Google</button><button class="secondary" name="decision" value="deny" formnovalidate>Cancel</button></form>${changeAccount}`);
}
