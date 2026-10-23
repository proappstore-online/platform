# PAS MCP operations

The general PAS server is `https://mcp.proappstore.online/mcp`. It provides 68
platform tools. App endpoints use `/mcp/apps/<app_id>` and expose that app's
registered actions plus identity and audit tools. See [connection setup and app
tools](mcp-app-tools.md) for client instructions.

## Action rejection contract

Registered actions propagate safe data-worker validation responses through MCP
with `isError: true`. A rejected D1 constraint returns HTTP 422 with
`errorCode: "constraint_violation"` and a fixed message; SQL, schema names, values
and arbitrary trigger text remain private. Exact trigger signals `stale revision`
(also `stale organisation revision`) and `operation key conflict` return HTTP 409
with `stale_revision` and `operation_conflict` respectively. Apps can use those
signals for optimistic concurrency and idempotency conflicts. Rejected D1 batches
roll back every statement. Schema defects and infrastructure failures remain
safe 5xx errors; their outcome may require reconciliation before retrying.

The data-worker script is embedded into the platform deployment. Existing app
workers need an owner-authorised `provision_app` preview and execution to receive
the new script; no migration or data reset is needed.

## Deployment and state

The source lives in `platform/packages/mcp`, not a standalone MCP repository.
Push to `main` triggers `deploy-mcp.yml`; public docs use `publish-docs.yml`.
Storefront instructions in `proappstore/skills.md`, `llms.txt` and
`build-with-ai.html` deploy from the separate storefront repository. Do not deploy
Workers or publish npm packages from a local machine.

The optional `@proappstore/mcp` npm launcher is a stdio compatibility bridge;
native remote clients should use the HTTPS URL directly. Its release is excluded
from the general `publish.yml`. Its dedicated manual release workflow is
`publish-mcp-registry.yml`: the npm package owner must configure a GitHub trusted
publisher for `proappstore-online/platform` and that workflow filename, then
dispatch **Publish PAS MCP npm bridge** from `main`. It validates both manifests
and the launcher, synchronizes their version, and publishes with OIDC provenance.
Do not substitute a local publish or long-lived npm token. Source metadata updates
do not update an already published npm README until that package is released.

The Worker uses the official MCP SDK's stateless HTTP transport. Each request
resolves its OAuth credential, verifies its underlying PAS session and resource
binding, then constructs a fresh tool server. A transport session ID carries no
identity. Standalone GET event streams are unsupported (405); clients use POST.

`OAUTH_STATE` is a SQLite Durable Object. All state transitions and credential
resolutions use the named `authority` instance and are serialized. Code redemption,
refresh rotation and revocation must never fall back to eventually consistent KV.
Missing authority/signing-key configuration fails closed with 503.
`MCP_ISSUER` names the canonical public origin. Internal service requests use
hosts such as `https://mcp`; those hosts must never become an OAuth issuer or
replace the public resource binding during broker credential issuance.

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
  The fetch uses Workers-supported `redirect: "manual"` and rejects non-2xx
  responses. Do not use `redirect: "error"`: Workers throws before fetching,
  causing valid native clients such as Codex to fail with `invalid client_id`.
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

For provisioning, use `provisioning_status` to read the durable receipt and
separate current deployment/route diagnostics. The historical section preserves
the original checks, including a host 404 while the first deployment was queued;
it does not claim that the app is still down. The current section has its own UTC
check timestamp, the latest GitHub Actions results and a route-health probe
through the HOST binding. An intentional private-app access gate counts as up.
Both diagnostics are bounded to five seconds and report unavailable/timeout
explicitly. Reading status never retries provisioning or updates the receipt.
An unauthorized receipt read performs no additional diagnostics. Fresh diagnostics
also require current app ownership: a former owner can still inspect their own
historical receipt, without reading the new owner's private repository activity.
Replaying `provision_pas_app` against a failed, exhausted or unreconciled receipt returns
`isError: true`; pending and completed receipts remain successful status results.
The legacy `scaffold_app` stops before infrastructure provisioning if template
configuration fails. Its repository may already exist: inspect the reported repo
and configuration error before retrying, rather than creating another app.

`mcp_audit_log` selects the newest events across all pages of the account's
90-day KV trail, then fetches at most the requested number of values (maximum
200). Large histories require more key-list requests. Audit storage remains
best-effort and eventually consistent; it is not the provisioning state authority.

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
