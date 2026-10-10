# Remote MCP authentication broker (PAS #355)

`/v1/mcp/broker/v1` is the versioned PAS broker contract.  It is an internal
companion-client protocol, not a replacement for the existing MCP OAuth 2.1
authorization-code endpoints.  Those endpoints and app-scoped protected
resources remain unchanged.

## Trust boundary and creation

PAGS (or another first-party coordinator) creates a request with the owner's
existing PAS bearer: `POST /v1/mcp/broker/v1/requests`.  It must never submit a
user id supplied by a machine.  The body has immutable `request_id` (a 32+ char
machine-generated opaque identifier), `{agent:{id,label},machine:{id,label}}`,
`resource`, `scopes`, `code_challenge` (PKCE S256), `machine_proof_hash`
(SHA-256 hex), and optional `expires_in_ms` (60,000–600,000; default 600,000).
The actual machine proof and verifier never leave the waiting machine.

The successful response is version `2026-10-10`, contains only `request_id`,
`pending`, expiry, and a neutral non-secret `status_url`.  A duplicate id is
rejected; requests cannot be edited.  The coordinator's authenticated request
page reads `GET /requests/:requestId` with that owner bearer and must display
the returned immutable agent, machine, service/resource, and scopes before
calling `POST /requests/:requestId/approve`.  That endpoint (as well as
`deny` and `cancel`) requires the same owner bearer, so a wrong owner fails
closed.  The hosted `GET /requests/:requestId/status` page is deliberately
neutral: it exposes only a coarse state, sends `no-store`/`no-referrer`, and
contains no token, code, proof, scope, or account information.

## Waiting machine

The machine calls `POST /requests/poll` with `{request_id,machine_proof}`.
It receives only `{protocol_version,request_id,status,retry_after_ms,expires_at}`;
it must honor the 2s minimum retry interval.  States are `pending`,
`approved_awaiting_machine`, `consumed`, `connected`, `denied`, `expired`,
`cancelled`, and `failed`.  Pending/approved requests become expired
deterministically on the next broker operation after expiry.

After `approved_awaiting_machine`, it calls `POST /requests/redeem` with
`{request_id,machine_proof,code_verifier}`.  The broker verifies both the
machine proof and S256 PKCE challenge, then atomically changes only one
approved row to `consumed`.  The PAS session result is encrypted at rest with a
key derived from `SESSION_SIGNING_KEY`; a lost response can be safely retried
only by the same proof/verifier and returns that same result.  Concurrent or
replayed redemption cannot mint a second result.  Results are intentionally not
logged or put in URLs, notification payloads, HTML, or status responses.

The #356 client adapter uses the session only through the existing MCP OAuth
flow for the originally requested protected resource.  After a harmless
authenticated MCP read actually succeeds, it calls `POST /requests/connected`
with the same proof and verifier.  Only then is the state `connected`; browser
approval alone is never reported as a connection.  If that authenticated read
cannot be completed, it instead calls `POST /requests/failed` with the same
proof and verifier; a failed request is terminal and the coordinator starts a
new request for an explicit retry.

## Compatibility and error contract

All normal responses carry `protocol_version: "2026-10-10"`.  Clients that do
not support that version must leave their working OAuth path untouched.  Bad
machine proof, unknown request, wrong owner, wrong PKCE, stale/terminal state,
and redemption races fail closed with generic 409 `remote-auth result
unavailable`; malformed requests are 400.  PAGS must treat these as a new
request/retry path, never as permission to substitute redirects or widen scopes.
