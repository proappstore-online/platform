# Remote MCP approval broker v2 (PAS #355)

`/v1/mcp/broker/v1/*` is permanently withdrawn and answers `503
remote_auth_unavailable`. Supported companion clients use version
`2026-10-10` at `/v1/mcp/broker/v2`.

This is a PAS companion-client protocol, not OAuth Device Authorization and
not a replacement for the standard MCP OAuth 2.1 authorization-code flow.
Normal MCP OAuth clients remain supported unchanged.

## Request and approval

An already authenticated first-party coordinator creates a request with its
owner's PAS bearer:

`POST /requests`

```json
{
  "agent": { "id": "codex", "label": "Codex" },
  "machine": { "id": "mac-42", "label": "Remote Mac" },
  "resource": "https://mcp.proappstore.online/mcp/apps/example",
  "scopes": [],
  "code_challenge": "PKCE-S256-base64url",
  "machine_proof_hash": "sha256-hex",
  "machine_public_key": "base64url-P-256-SPKI"
}
```

PAS generates the immutable 256-bit `req_…` request id. Resource is exactly
the configured MCP origin plus `/mcp` or `/mcp/apps/:appId`; query strings,
fragments, alternate origins, and trailing-path variants are rejected. PAS has
no MCP scope taxonomy today, so requests accept only `[]` and responses report
`effective_scopes: []`.

The response contains no credential: request id, `pending`, expiry, an
`approval_url`, and neutral `status_url`. A bearer can inspect only its own
request through `GET /requests/:requestId`; it cannot approve it.

The approval URL shows immutable agent, machine, resource, and scopes. The
owner explicitly selects GitHub or Google sign-in. PAS reuses its provider
state cookie and redirects back with a short-lived HttpOnly cookie, never a
PAS JWT or login code in the URL. The provider-verified user must equal the
stored owner before PAS permits `POST /requests/:requestId/approve`, `deny`, or
`cancel`. This binds owner, browser state, immutable request, machine proof,
and PKCE without trusting a PAGS bearer as a login bootstrap.

## Machine protocol

The machine keeps its proof, PKCE verifier, and P-256 private key locally.
It polls:

`POST /requests/poll { "request_id", "machine_proof" }`

Polls are server-limited to one per two seconds. Early polls receive `429
slow_down`; successful responses contain only coarse status and expiry.

After `approved_awaiting_machine`, redeem with:

`POST /requests/redeem { "request_id", "machine_proof", "code_verifier", "redeem_attempt_id" }`

The broker verifies SHA-256 proof and PKCE S256, then conditionally changes
only an unexpired approved row to `consumed`, using `UPDATE ... WHERE
status='approved_awaiting_machine' ... RETURNING`. `redeem_attempt_id` is a
fresh, high-entropy machine value for one network attempt. A client may reuse
it only to recover a lost response; a concurrent or later attempt using a
different ID receives 409. Its response is an envelope
`{ephemeral_public_key, iv, ciphertext}`. The payload is AES-GCM encrypted
from a fresh P-256 ECDH ephemeral key to the immutable machine public key, with
the request id as associated data. It contains only the opaque resource-bound
MCP credential. PAS sessions are never returned or stored by the broker.

A lost response may be retried by the same proof/verifier until the explicit
five-minute result-retention deadline. It returns the same encrypted envelope;
no second credential is minted. The five-minute cleanup sweep expires pending
claims, wipes stale consumed results, and prunes terminal records.

The companion then completes a harmless authenticated MCP transport read. The
MCP worker records that successful resource-bound call. Only after the API
broker verifies this service-bound receipt may the same machine report
`POST /requests/connected`; otherwise it must report `failed`. Browser
approval is never reported as connected.

## States and errors

States are `pending`, `approving`, `approved_awaiting_machine`, `consumed`,
`connected`, `denied`, `expired`, `cancelled`, and `failed`. Every state claim
uses a D1 conditional update that includes `expires_at > now`; denial,
cancellation, expiry, callback, approval, redemption and reconnect races fail
closed. Unknown request, wrong owner/proof/verifier, stale state and replay use
the generic `409 remote_auth_unavailable` response. Malformed input is `400`.

`GET /requests/:requestId/status` is deliberately neutral and sends
`Cache-Control: no-store` and `Referrer-Policy: no-referrer`. No secret,
account identity, proof, verifier, token, scope, or target details appear in a
status page, URL, error, or logging contract.
