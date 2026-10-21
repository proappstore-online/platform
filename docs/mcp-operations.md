# PAS MCP operations

The general PAS server is `https://mcp.proappstore.online/mcp`. It provides 68
platform tools. App endpoints use `/mcp/apps/<app_id>` and expose that app's
registered actions plus identity and audit tools. See [connection setup and app
tools](mcp-app-tools.md) for client instructions.

## Deployment and state

The source lives in `platform/packages/mcp`, not a standalone MCP repository.
Push to `main` triggers `deploy-mcp.yml`; public docs use `publish-docs.yml`.
Storefront instructions in `proappstore/skills.md`, `llms.txt` and
`build-with-ai.html` deploy from the separate storefront repository. Do not deploy
Workers or publish npm packages from a local machine.

The optional `@proappstore/mcp` npm launcher is a stdio compatibility bridge;
native remote clients should use the HTTPS URL directly. Its release is excluded
from `publish.yml` until the npm package owner configures a trusted publisher for
`proappstore-online/platform`, workflow `publish.yml`. Do not substitute a local
publish or long-lived npm token. Source metadata updates do not update an already
published npm README until that separate package is released.

The Worker uses the official MCP SDK's stateless HTTP transport. Each request
resolves its OAuth credential, verifies its underlying PAS session and resource
binding, then constructs a fresh tool server. A transport session ID carries no
identity. Standalone GET event streams are unsupported (405); clients use POST.

`OAUTH_STATE` is a SQLite Durable Object. All state transitions and credential
resolutions use the named `authority` instance and are serialized. Code redemption,
refresh rotation and revocation must never fall back to eventually consistent KV.
Missing authority/signing-key configuration fails closed with 503.

Migration `v2` adds `OAuthState` and retains the historical `PasMcpAgent` binding.
For 90 days after first initialization, the authority can read existing OAuth
records from `OAUTH_KV`. Local values and deletion tombstones take precedence, so
spent legacy codes and revoked tokens cannot reappear. After that window only
durable state is accepted. Expired secret values are cleared by an hourly alarm;
tombstones remain until legacy fallback ends. `OAUTH_KV` continues to store the
existing redacted audit trail. No credential export or manual copy is required.

Do not downgrade to a KV-only OAuth implementation after this migration: it would
ignore durable revocations and rotations. Prefer a forward fix. Any emergency
rollback must preserve `OAuthState`, its binding, tombstones and resource checks.

## Authentication and interoperability

- Browser sign-in uses PKCE S256, issuer-bound responses and endpoint-bound opaque
  access credentials. Raw PAS session JWTs and personal app tokens are not accepted
  by MCP. Tools never ask for credentials as arguments.
- Public clients may dynamically register. Trusted HTTPS client metadata documents
  are supported for hosts in `OAUTH_CIMD_HOSTS`; redirects, credentials and
  untrusted-host fetches are refused. Other clients use dynamic registration.
- Refreshes rotate to one successor. A retry within 30 seconds returns the same
  pair with its remaining access lifetime; later reuse revokes the family.
  `/revoke` implements client-bound revocation. App grants can also be revoked
  from the app's MCP settings.
- Access lasts up to 24 hours. Refresh tokens have a default 90-day inactivity
  window. Privileged claims cannot outlive the original sign-in expiry; near that
  deadline both the new internal session and access lifetime are capped. A fresh
  browser sign-in is needed to recover expired privileged roles.
- Browser transport origins must match the server origin or
  `MCP_ALLOWED_ORIGINS`. Origin-less native clients remain supported. Add a new
  browser origin deliberately rather than allowing every origin.

## Verification and troubleshooting

Run the repository quality gates in `CLAUDE.md`. The MCP workerd suite
(`pnpm --filter @proappstore/runtime-tests test:mcp`) exercises the real transport
and SQLite authority, including concurrent exchanges, refresh retries, immediate
revocation, identity isolation, annotations, schema validation and error flags.
Registry tests validate both discovery manifests against the pinned official
schema. When changing tools, update both manifest catalogues and the count guard.

After deployment, check public OAuth metadata and the 401 discovery challenge.
From the configured MCP connection call `whoami`, `list_apps` and `list_templates`.
Verify the expected account and read behavior before consequential operations.
Use a fresh client session to reload tool schemas after deployment.

If a client reports authorization required or cannot refresh, run
`codex mcp login proappstore` (or the client's reconnect/sign-in action), complete
the browser flow and verify `whoami`. Do not extract credentials from local files.
Check Worker logs for 503 authority failures, missing bindings, migration errors
or backend/service-binding failures; never include Authorization headers, tokens,
OAuth codes or session cookies in logs or support tickets.

An installed server and an `@` plugin mention are separate client features. If
tools work but a mention is missing, verify the ProAppStore plugin is installed
and enabled globally or in the intended workspace, then start a new host session.
A plugin's immutable internal package identifier may retain its original name;
its displayed name and available capabilities should describe general PAS access.
