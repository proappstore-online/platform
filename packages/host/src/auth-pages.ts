/**
 * Platform-owned sign-in and invite pages (#259 review), served on every app
 * origin under /.pas/auth/ — the one prefix the private-app gate lets through.
 *
 * Why the platform owns them: a private app's own pages are behind the gate
 * (visibility-gate.ts), so its sign-in screen and its `/join/<code>` invite page
 * cannot load for exactly the people who need them — a visitor who has not
 * signed in yet, and an invitee whose role does not exist until the invite is
 * redeemed. These pages need nothing from the app.
 *
 *   GET  /.pas/auth/signin?return_to=/path   every sign-in method the platform
 *        has: GitHub and Google (OAuth, /.pas/auth/start), an emailed sign-in
 *        link (/.pas/auth/email/start — also how someone with no account gets
 *        one) and email + password (/.pas/auth/credentials/login). Passkeys are
 *        not offered: the platform supports them only as a step-up AFTER sign-in
 *        (/.pas/auth/passkey/*, #230), never as a first factor.
 *   GET  /.pas/auth/join?code=CODE           signed out → the sign-in page,
 *        returning to /join/CODE; signed in → an "Accept invite" form.
 *   POST /.pas/auth/join                      redeems the code as the session
 *        (POST /v1/invites/:code/redeem, scoped to THIS app) and redirects to
 *        /join/CODE — which the gate now admits — or explains why it cannot.
 *
 * Redemption is a POST behind a click, never a GET: a link alone must not be
 * able to grant a role to whoever happens to follow it while signed in.
 */
import { AUTH_PREFIX, clearSessionCookie, fetchMe, isSameOriginMutation, readCookie, sameOriginPath, SESSION_COOKIE_NAME } from "./auth-handler.js";
import type { Env } from "./env.js";
import type { Route } from "./host.js";
import { askVisibilityFresh, inviteCodeFromPath } from "./visibility-gate.js";

const API_BASE = "https://api.proappstore.online";

export async function signInPage(request: Request, env: Env, route: Route): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return plain(405, "Method not allowed", { Allow: "GET" });
  const url = new URL(request.url);
  const returnTo = sameOriginPath(url, url.searchParams.get("return_to"));
  const token = readCookie(request.headers.get("Cookie"), SESSION_COOKIE_NAME);
  const who = token ? await signedInAs(env, token) : null;

  const start = (provider: string) => `${AUTH_PREFIX}/start?${new URLSearchParams({ provider, return_to: returnTo })}`;
  const body = who
    ? `<h1>Signed in</h1>
<p class="lede">You are signed in as <strong>${esc(who)}</strong>. If this app refused you, it was not shared with this account.</p>
<a class="btn primary" href="${esc(returnTo)}">Continue</a>
<button class="btn" type="button" id="switch">Use a different account</button>`
    : `<h1>Sign in to ${esc(route.slug)}</h1>
<p class="lede">Sign in to continue. Use the account the app's owner shared it with.</p>
<a class="btn" href="${esc(start("github"))}">Continue with GitHub</a>
<a class="btn" href="${esc(start("google"))}">Continue with Google</a>
<p class="sep">or with your email</p>
<form id="email-link">
  <label for="email">Email</label>
  <input id="email" name="email" type="email" autocomplete="email" required>
  <button class="btn primary" type="submit">Email me a sign-in link</button>
</form>
<details>
  <summary>Sign in with a password</summary>
  <form id="password">
    <label for="login">Email or username</label>
    <input id="login" name="login" autocomplete="username" required>
    <label for="pw">Password</label>
    <input id="pw" name="password" type="password" autocomplete="current-password" required>
    <button class="btn primary" type="submit">Sign in</button>
  </form>
</details>
<p class="fine">No account yet? The email link creates one. Passkeys can be added once you are signed in.</p>`;

  const script = `
const returnTo = ${jsonForScript(returnTo)};
const status = document.getElementById("status");
const say = (t) => { status.textContent = t; };
const post = (path, data) => fetch(path, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
const emailForm = document.getElementById("email-link");
if (emailForm) emailForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  say("Sending…");
  const r = await post("${AUTH_PREFIX}/email/start", { email: emailForm.email.value, returnTo }).catch(() => null);
  say(r && r.ok ? "Check your inbox for a sign-in link." : "Could not send the link. Check the address and try again.");
});
const pwForm = document.getElementById("password");
if (pwForm) pwForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  say("Signing in…");
  const r = await post("${AUTH_PREFIX}/credentials/login", { login: pwForm.login.value, password: pwForm.password.value }).catch(() => null);
  if (r && r.ok) location.assign(returnTo); else say("Wrong email, username or password.");
});
const sw = document.getElementById("switch");
if (sw) sw.addEventListener("click", async () => {
  await fetch("${AUTH_PREFIX}/logout", { method: "POST", credentials: "same-origin" }).catch(() => null);
  location.reload();
});
const err = /auth_error=([^&]+)/.exec(location.hash);
if (err) say("Sign-in did not complete (" + decodeURIComponent(err[1]) + "). Try again.");
`;
  return page(`Sign in · ${route.slug}`, body, script);
}

export async function joinPage(request: Request, env: Env, route: Route): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "POST") return redeem(request, env, route);
  if (request.method !== "GET" && request.method !== "HEAD") return plain(405, "Method not allowed", { Allow: "GET, POST" });

  const code = normaliseCode(url.searchParams.get("code"));
  if (!code) return page("Invite", `<h1>That invite link is not valid</h1><p class="lede">Ask whoever sent it for a new one.</p>`);
  const token = readCookie(request.headers.get("Cookie"), SESSION_COOKIE_NAME);
  const who = token ? await signedInAs(env, token) : null;
  if (!who) return signInFirst(url, code, Boolean(token));

  return page(
    `Invite · ${route.slug}`,
    `<h1>You have been invited to ${esc(route.slug)}</h1>
<p class="lede">Accept the invite as <strong>${esc(who)}</strong> to open the app.</p>
<form method="post" action="${AUTH_PREFIX}/join">
  <input type="hidden" name="code" value="${esc(code)}">
  <button class="btn primary" type="submit">Accept invite</button>
</form>
<a class="btn" href="${esc(`${AUTH_PREFIX}/signin?${new URLSearchParams({ return_to: `/join/${code}` })}`)}">Not you? Use a different account</a>`,
  );
}

async function redeem(request: Request, env: Env, route: Route): Promise<Response> {
  if (!isSameOriginMutation(request)) return plain(403, "Forbidden");
  const url = new URL(request.url);
  const form = await request.formData().catch(() => null);
  const code = normaliseCode(typeof form?.get("code") === "string" ? (form!.get("code") as string) : null);
  if (!code) return page("Invite", `<h1>That invite link is not valid</h1><p class="lede">Ask whoever sent it for a new one.</p>`, "", 400);
  const token = readCookie(request.headers.get("Cookie"), SESSION_COOKIE_NAME);
  if (!token) return signInFirst(url, code, false);

  let upstream: Response;
  try {
    upstream = await env.API.fetch(
      new Request(`${API_BASE}/v1/invites/${encodeURIComponent(code)}/redeem`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-PAS-App": route.slug },
        // Scoped to this app: a code minted for another app is "not found" here.
        body: JSON.stringify({ appId: route.slug }),
      }),
    );
  } catch {
    return page("Invite", `<h1>Could not accept the invite</h1><p class="lede">Something went wrong on our side. Try again in a moment.</p>`, "", 503);
  }
  if (upstream.status === 401) return signInFirst(url, code, true);
  if (!upstream.ok) {
    const why = upstream.status === 404 ? "This invite does not exist for this app." : upstream.status === 410 ? "This invite has expired or has already been used up." : "The invite could not be accepted.";
    return page("Invite", `<h1>Could not accept the invite</h1><p class="lede">${esc(why)} Ask whoever sent it for a new one.</p>`, "", upstream.status === 404 || upstream.status === 410 ? upstream.status : 502);
  }

  // The role exists now; drop this isolate's remembered refusal so the next
  // request sees it, and only send them on if it actually opens the app.
  const answer = await askVisibilityFresh(env, route.slug, token);
  if (answer === "allowed" || answer === "unavailable") {
    return new Response(null, { status: 303, headers: { Location: new URL(`/join/${code}`, url.origin).toString(), "Cache-Control": "no-store" } });
  }
  return page(
    "Invite",
    `<h1>Invite accepted</h1><p class="lede">The role this invite grants does not open ${esc(route.slug)} on its own. Ask the app's owner for access.</p>`,
  );
}

/** Sign in first, then come back to the invite link (which the gate routes here again). */
function signInFirst(url: URL, code: string, clearCookie: boolean): Response {
  const target = new URL(`${AUTH_PREFIX}/signin`, url.origin);
  target.searchParams.set("return_to", `/join/${code}`);
  const headers = new Headers({ Location: target.toString(), "Cache-Control": "no-store" });
  if (clearCookie) headers.append("Set-Cookie", clearSessionCookie());
  return new Response(null, { status: 303, headers });
}

function normaliseCode(raw: string | null): string | null {
  return raw ? inviteCodeFromPath(`/join/${raw}`) : null;
}

/** Display name of the session's user, or null when there is no valid session. */
async function signedInAs(env: Env, token: string): Promise<string | null> {
  try {
    const me = await fetchMe(env, token);
    if (!me.ok) return null;
    const user = JSON.parse(me.body) as { login?: unknown; name?: unknown; email?: unknown; id?: unknown };
    for (const v of [user.login, user.name, user.email, user.id]) if (typeof v === "string" && v) return v;
    return "your account";
  } catch {
    return null;
  }
}

function page(title: string, body: string, script = "", status = 200): Response {
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style nonce="${nonce}">
:root { --paper: #f7f7f8; --panel: #ffffff; --line: #d9d9de; --ink: #17171c; --muted: #5d5d66; --accent: #4f46e5; --accent-ink: #ffffff; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --paper: #111114; --panel: #1b1b20; --line: #33333b; --ink: #ececf1; --muted: #a2a2ad; --accent: #8b85ff; --accent-ink: #111114; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--paper); color: var(--ink); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { width: 100%; max-width: 400px; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 24px; display: grid; gap: 12px; }
h1 { font-size: 1.25rem; margin: 0; }
.lede, .fine, .sep { margin: 0; color: var(--muted); }
.fine { font-size: 0.875rem; }
.sep { text-align: center; font-size: 0.875rem; }
form { display: grid; gap: 8px; margin: 0; }
label { font-size: 0.875rem; }
input { font: inherit; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--paper); color: var(--ink); }
.btn { display: block; width: 100%; text-align: center; font: inherit; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--ink); text-decoration: none; cursor: pointer; }
.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
details { display: grid; gap: 8px; }
summary { cursor: pointer; color: var(--muted); }
#status:empty { display: none; }
</style>
</head>
<body>
<main>
${body}
<p id="status" class="fine" role="status"></p>
</main>
${script ? `<script nonce="${nonce}">${script}</script>` : ""}
</body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      // An invite code rides in this page's URL; never leak it onward.
      "Referrer-Policy": "no-referrer",
    },
  });
}

function plain(status: number, text: string, extra: Record<string, string> = {}): Response {
  return new Response(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...extra } });
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A string literal safe inside an inline <script>: JSON, with `<` escaped so `</script>` cannot close it. */
function jsonForScript(value: string): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
