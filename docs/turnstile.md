# Bot protection with Cloudflare Turnstile

Cloudflare Turnstile is the platform's bot / abuse layer on the two entry
points a script could drive without a human (#26): anonymous
**self-registration** on the API and **browser-driven publishes** on the admin
Worker. The page renders the Turnstile widget (invisible for most visitors),
sends the token it yields with the request, and the Worker verifies that token
once with Cloudflare before doing anything else. Everything is inert until the
keys are set, so it can be rolled out one Worker at a time.

## Where it applies

| Surface | Worker | Token travels as | Widget `data-action` | Site key from |
|---|---|---|---|---|
| `POST /v1/auth/credentials/register` (and `/.pas/auth/credentials/register` on app origins) | `proappstore-api` | `turnstileToken` body field or `CF-Turnstile-Response` header | `register` | `GET /v1/auth/turnstile` (`/.pas/auth/turnstile` on an app origin) |
| `POST /api/publish-app` **when the request carries an `Origin` header** (the console's publish form) | `proappstore-admin` | same | `publish` | `GET /api/turnstile` |

Not covered, on purpose:

- `pas publish` from the CLI and any other request with no `Origin` header. A
  terminal cannot render a widget; those callers stay on the session
  requirement plus the provision guard (#83: one app id per owner, per-caller
  and per-address rate limits).
- Sibling Workers on `INTERNAL_TOKEN` (Agent Teams deploys): already
  authenticated and owner-gated upstream.
- Sign-in. Failed credential logins are rate-limited per login; OAuth sign-in
  is the provider's problem.

## Verification rules

- **All-or-nothing per Worker.** The check is enforced only when *both*
  `TURNSTILE_SITE_KEY` (a var, public) and `TURNSTILE_SECRET_KEY` (a secret)
  are set. A Worker with only the secret set stays inert, so a half-finished
  rollout can never lock every caller out. The config endpoints answer
  `siteKey: null` while the check is off, and a form renders no widget then.
- **Fail closed.** A token Cloudflare rejects → `403 { error: "bot check
  failed" }`; a request with no token while the check is on → `403 { error:
  "bot check required" }`; the challenge service unreachable → `503 { error:
  "bot check unavailable — please try again" }`. The form re-renders the widget
  and retries.
- **Action pinned.** The token's `action` must equal the surface's
  (`register` / `publish`), so a token minted on a sign-up page cannot be
  replayed on a publish. Tokens are single-use and expire after five minutes.
- **Visitor address forwarded.** `CF-Connecting-IP` goes to siteverify as
  `remoteip`; the host Worker forwards it on the mediated registration path.
- The bot check runs before validation, hashing and the per-IP registration
  counter, so a scripted flood costs nothing but the siteverify call.

## Enabling it

1. Create a Turnstile widget in the Cloudflare dashboard (Turnstile → Add
   widget). Hostnames: `proappstore.online` and the app domains the sign-up
   forms live on (`*.proappstore.online` covers hosted apps; add any custom
   domains). Mode: *Managed* (invisible unless a visitor looks suspicious).
   One widget can serve both Workers; use two if you want separate analytics.
2. Update the forms first — they read the site key from the config endpoint,
   render the widget only when it is non-null, and send the token:
   - hosted apps: `@proappstore/sdk` ≥ 1.16.50 —
     `auth.turnstileSiteKey()` then `auth.register(email, password,
     displayName, { turnstileToken })`;
   - the dashboard's sign-up page and the console's publish form (separate
     repos) must do the same against `GET /v1/auth/turnstile` and
     `GET /api/turnstile`.
3. Set the keys on each Worker, secret first, var second (the var is what
   turns the check on, because it is the half the forms can see):

   ```bash
   cd ~/dev/secrets && sops secrets.enc.yaml            # add pas.TURNSTILE_SECRET_KEY
   sops -d --extract '["pas"]["TURNSTILE_SECRET_KEY"]' ~/dev/secrets/secrets.enc.yaml | \
     pnpm --filter @proappstore/backend exec wrangler secret put TURNSTILE_SECRET_KEY
   sops -d --extract '["pas"]["TURNSTILE_SECRET_KEY"]' ~/dev/secrets/secrets.enc.yaml | \
     pnpm --filter @proappstore/admin exec wrangler secret put TURNSTILE_SECRET_KEY
   ```

   Then uncomment `TURNSTILE_SITE_KEY` in `packages/backend/wrangler.toml` and
   `packages/admin/wrangler.toml` with the widget's site key and push — the
   deploy workflows apply it. Watch `auth_failures` for
   `register_turnstile_rejected` / `register_turnstile_missing-token` spikes
   after the flip: the first means bots, the second means a form that did not
   get the update.

For local development and CI use Cloudflare's test pair — site key
`1x00000000000000000000AA`, secret `1x0000000000000000000000000000000AA` —
which passes every token (`TURNSTILE_TEST_SITE_KEY` / `TURNSTILE_TEST_SECRET_KEY`
in `@proappstore/build-core`). The verifier itself is
`packages/build-core/src/turnstile.ts`, shared by both Workers.

## Rendering the widget

```html
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<form id="signup">
  …
  <div class="cf-turnstile" data-sitekey="SITE_KEY" data-action="register" data-response-field-name="turnstileToken"></div>
</form>
```

With the SDK:

```ts
const { siteKey, action } = await app.auth.turnstileSiteKey();
// render <div class="cf-turnstile" data-sitekey={siteKey} data-action={action}> only when siteKey is set;
// read the token from the widget (turnstile.getResponse() or the hidden input) on submit:
await app.auth.register(email, password, displayName, { turnstileToken });
```
