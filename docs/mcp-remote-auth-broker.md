# Remote MCP approval broker (withdrawn pending a safe implementation)

The `/v1/mcp/broker/v1/*` routes are disabled and return `503` with
`remote_auth_unavailable`. They do not create requests, accept approvals,
return credentials, or expose a status page. They are deliberately mounted to
refuse old URLs explicitly, with `Cache-Control: no-store` and
`Referrer-Policy: no-referrer`.

Do not integrate against this endpoint. PAS #356 and #1005 must use the
existing OAuth 2.1 authorization-code + PKCE flow at
`https://mcp.proappstore.online/authorize` until a replacement is published.
That flow is the current supported credential boundary: it issues opaque
24-hour credentials, and the MCP worker enforces each credential's resource
binding at `/mcp` or `/mcp/apps/:appId` before dispatch.

## Conditions to publish a broker contract

PAS #355 remains open. A broker revision can be published only after all of
the following are implemented and independently tested:

1. The API worker calls an authenticated MCP-worker service binding to issue
   an opaque OAuth credential bound to one canonical MCP resource. It must
   never return a PAS session JWT. PAS currently has no MCP scope taxonomy, so
   an effective scope set must be empty rather than accepting cosmetic scope
   labels.
2. Resource input is limited to the configured MCP origin and exactly
   `/mcp` or `/mcp/apps/:appId`; the MCP worker rejects that credential at any
   other resource.
3. Hosted approval uses the existing PAS GitHub/Google provider callback and
   binds the returned user, browser state, request, machine proof, and PKCE
   challenge. An existing PAGS bearer alone is not sufficient for first login
   or expired-session recovery.
4. Database claims include `expires_at > now` in every conditional mutation;
   consumed-result retry has a short explicit retention deadline and a cleanup
   job; deny, cancel, expiry, callback, and duplicate/reconnect races have
   terminal state transitions.
5. Polling has a server-enforced limit/backoff, not merely a client hint.
   Tests use real D1 conditional semantics and cover cross-resource denial,
   owner/machine/PKCE/state/request mismatch, expiry/replay/deny/cancel,
   lost response/reconnect, secret redaction, provider return, and mobile E2E.

Until those prerequisites exist, there is no broker protocol version, request
or response schema, approval URL, error-code contract, or supported client
integration beyond the stable `503` refusal above.
