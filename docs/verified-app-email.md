---
description: "Send and receive mail from an app's own verified domain through the platform: sender identities, pas.email.send, quotas and suppression, delivery, bounce and inbound events."
---

# Verified app email

An app sends and receives mail on **its own domain** through the platform (#566). The platform
owns the sender identity, the send, the idempotency, the quotas and the events; the app owns
which sender to use, its templates and approval rules, and matching a reply to its own records.
Nothing here is specific to one app.

The provider is **Cloudflare Email Service** (Email Sending and Email Routing, public beta), in the
platform's own Cloudflare account: no third-party vendor, no API key. It is inert until Email Service is
enabled and the `EMAIL` binding exists: every call then answers `email_not_configured` (HTTP 503 /
worker `Unavailable`) and makes no provider call. The older `app.email.send` (platform sender
`noreply@proappstore.online`, 100 a day) is unchanged and still uses its own `RESEND_API_KEY`.

## The model

1. **Claim a domain.** The owner posts the domain. It is `pending` until a **platform administrator
   attests** that it is a zone in the platform's Cloudflare account and is onboarded to Email Sending
   (Cloudflare then configures SPF, DKIM and DMARC itself, so there are no records for the owner to add).
   The attestation is the proof of control: Cloudflare lets any worker of the account send from any
   onboarded domain, so the provider alone cannot stop one app using another's domain. A domain belongs to
   one app: a domain verified for another app is refused (`domain_taken`); an unverified claim does not
   block anyone, it is displaced by the next claimant. `proappstore.online` and its subdomains cannot be
   claimed. Withdrawing the attestation stops every identity on the domain.
2. **Declare an identity.** An owner or editor declares an address on a claimed domain. It starts
   `pending`.
3. **Approve.** Only the owner approves, and chooses `allowExternal` (may it mail people with no
   relationship to the app?). The owner can revoke at any time; an administrator can suspend an
   identity or the whole app (kill switch).
4. **Send.** An identity sends only while it is `approved`, not suspended, and its domain is
   `verified`. Anything else refuses with a stable code and makes **zero provider calls**. There is
   never a fallback to another sender.

## Routes (all under `/v1`)

| Route | Who | |
|---|---|---|
| `GET /apps/:appId/email` | owner | `{ configured, suspended, limits, usage, domains[], identities[] }`; no secret anywhere |
| `POST /apps/:appId/email/domains` `{ domain }` | owner | 201, `pending`; `records` is always empty (Cloudflare configures DNS on onboarding) |
| `POST /apps/:appId/email/domains/:domain/verify` | owner | the claim's current status; verification is the administrator's |
| `DELETE /apps/:appId/email/domains/:domain` | owner | revokes its identities |
| `POST /apps/:appId/email/identities` `{ address, displayName?, replyTo? }` | owner, editor | 201, `pending` |
| `POST /apps/:appId/email/identities/:id/approve` `{ allowExternal? }` | owner | |
| `POST /apps/:appId/email/identities/:id/revoke` | owner | |
| `POST /apps/:appId/email/send` | owner, editor | see below; 201 new, 200 replay |
| `GET /apps/:appId/email/sends[/:id]` | owner, editor | the platform's send records and their events |
| `GET /apps/:appId/email/suppressions` | owner | |
| `POST /admin/email/domains/:domain` `{ verified?, forwardCopyTo? }` | admin | attest (or withdraw) that the domain is an onboarded Cloudflare zone. `forwardCopyTo` (an email address, or `null` to clear) sets the inbound copy-forward below and leaves the attestation unchanged when `verified` is absent |
| `POST /admin/email/apps/:appId` `{ suspended, reason?, dailyLimit?, identityDailyLimit?, burstLimit? }` | admin | kill switch and quota overrides (null = default) |
| `POST /admin/email/apps/:appId/identities/:id/suspend` `{ suspended, reason? }` | admin | |

Errors are `{ error, errorCode, code }`; `code` is the stable one below.

## Sending

Worker: `await pas.email.send(input)`. Route: `POST /v1/apps/:appId/email/send` with the same body.

```ts
{
  identity: 'careers@betabuilders.org', // id or registered address of one of the app's identities
  to: 'a@example.com' | ['a@example.com', ...], // 1-10
  subject: 'Interview',                 // one line, <= 200
  text?: 'plain text',                  // <= 200,000 chars
  html?: '<p>the app's own markup</p>', // <= 200,000 chars
  replyTo?: 'x@betabuilders.org',       // default: the identity's replyTo
  idempotencyKey: 'candidate-42-invite' // required, 1-200 of A-Za-z0-9._:-
}
```

There is no `from`. A `from`, `sender`, `providerId`, `messageId`, `sentAt`, `timestamp`, `createdAt`,
`appId` or `headers` field is refused (`invalid_request`): the sender is the registered identity, the
app is the caller's, and the timestamps are the server's.

Bodies: with only `text`, the HTML part is that text HTML-escaped. With only `html`, it is sent as the
HTML part and the text part is the same with tags stripped. With both, each is sent as given. The two
parts are never the same string; caller markup is never presented as escaped when it is not.

Result: `{ id, status, providerId, from, to, createdAt, acceptedAt, errorCode, replayed }`.
`status` is `accepted` (the provider took it; **not** delivered), `refused` (the provider rejected it,
final for that key) or `unknown` (see below).
`createdAt` and `acceptedAt` are server times in epoch milliseconds.

Idempotency: the same key and message returns the same record (`replayed: true`) and never sends
again, including after an `unknown`. The same key with a different message is `idempotency_conflict`.
Cloudflare has no idempotency key, so the platform's own record is the only guard. A send whose outcome
is unknown (`status: unknown`, `errorCode: provider_unavailable`) is returned as it is on a retry and is
**not** sent again, because it might have been delivered; use a new key to send again. Only a send Cloudflare
reported as not sent (`errorCode: provider_busy`: rate limit, daily limit, domain not ready) is tried again
under the same key.

### Recipient rule

An identity approved without `allowExternal` may mail only people related to the app: its creator, its
team members and holders of an app role, matched by their account email. Anyone else is
`external_recipient_not_allowed`. With `allowExternal` it may mail anyone. This is a stricter, separate
rule from #466's, which will define its own recipient set but must send through `sendAppEmail`.

### Quotas

Per app 500 a day, per identity 300 a day, 30 a minute per app, 10 recipients a message. An
administrator can override per app. The slot is reserved in the same statement as the idempotency key,
so concurrent sends cannot all pass a count. Refused sends do not count. One app's quota never limits
another. Suppression is per app: a permanent bounce or a complaint for an address suppresses it for
that app only (`recipient_suppressed`). The provider's own team-level suppression is shared and not
under the platform's control.

### Codes

`email_not_configured` `invalid_request` `sender_not_found` (also another app's identity) `sender_not_approved`
`sender_revoked` `sender_suspended` `sender_domain_unverified` `app_suspended` `external_recipient_not_allowed`
`recipient_suppressed` `quota_app_daily` `quota_identity_daily` `quota_burst` `idempotency_conflict`
`domain_not_claimed` `domain_taken` `domain_reserved` `address_taken` `not_found`.
In a worker the class is `Forbidden` (all refusals), `BadRequest` (`invalid_request`,
`idempotency_conflict`), `RateLimited` (quotas), `Unavailable` (`email_not_configured`), `NotFound`,
`Failed`; the message is `<Class>: <code>[: detail]`.

## Events

Delivery, bounce and complaint events come from the Email Sending **events queue** (`pas-email-events`);
inbound mail comes from the backend worker's Email Routing `email()` handler. Neither is reachable from
the internet, so there is no webhook to sign. The platform de-duplicates on the event id, attributes the
event to its app, and gives the app's worker a **hook event** through the app-events queue (at least
once, retried with backoff, dead-lettered). Cloudflare reports per recipient, so a hard bounce or a
complaint suppresses exactly that recipient. A bounce is permanent when Cloudflare's `bounce.type` says
hard or permanent. The envelope `id` is stable across retries: handle each
once. `event.name` is the hook name; `event.hook.body` is JSON (`emailEventOf(event)` in
`@proappstore/sdk/worker` parses it). The app does not declare these hooks in `mcp.json`.

| `event.name` | Body |
|---|---|
| `pas.email.delivered` | `{ type, id, sendId, providerId, from, to[], occurredAt, suppressed: false }` |
| `pas.email.bounced` | the same plus `permanent` and `bounce: { type, subType, message }`; `suppressed` is true for a permanent bounce |
| `pas.email.complained` | the same, `suppressed: true` |
| `pas.email.inbound` | `{ type, id, receivedAt, identity: { id, address }, providerId (SHA-256 of the raw message), messageId, from, to[], subject, text, html, truncated, headers: { in-reply-to, references, reply-to, date }, authentication: { spf, dkim, dmarc } \| null, attachments: [{ id, filename, contentType, size, quarantined: true }] }` |

History is appended, never rewritten: `GET .../sends/:id` and `pas.email.get(id)` return the record with its
`events`, and `deliveredAt` / `bouncedAt` / `complainedAt` are set once. An event for a message the
platform did not send through this feature is ignored; deferred, failed and rejected events are kept as history
and not sent to the app. Inbound mail is routed only to an approved, unsuspended identity on a verified
domain of an app that is not suspended; any other recipient is rejected at the SMTP door (550). A failure
after that makes Email Routing report a temporary failure, so the sender retries. Trust `authentication`, never the From header or a display name. Attachment bytes are never
delivered (metadata only, quarantined). Bodies over 200,000 characters are cut and `truncated` is true.

### Copy-forward of inbound mail

A domain can carry an optional `forwardCopyTo`, set by an administrator. After an inbound message is
accepted and its `pas.email.inbound` event is queued, the handler calls `message.forward(forwardCopyTo)`,
so a mailbox keeps receiving a copy while its address moves from forwarding to the worker. It applies to
every identity on the domain. The address must be a **verified destination address** in Email Routing,
or the forward fails. A failed forward is logged as the short code `forward_failed` (never an address,
header or body) and does not reject, retry or otherwise affect the message. Clear it with `null`.

## Retention and deletion

Send records, their events, suppressions and inbound metadata (no bodies) are kept until the app is
deleted; there is no automatic pruning yet. Hook deliveries of these events follow the hook rule (14
days). Cloudflare keeps its own activity log (up to 30 days; preview content about 7 days) and its own
account-level suppression list; deleting an app's records does not delete the provider's copy. Inbound
bodies are not stored by the platform in this version.

## Going live

Nothing is declared in `wrangler.toml` until the owner turns it on, so the deploy cannot break first.

1. Dashboard: enable Email Service on the platform account (Workers Paid for sending to arbitrary recipients).
2. Set the repository variable `EMAIL_SERVICE_ENABLED=true` on `proappstore-online/platform` and let
   `Deploy Worker` run: it appends `packages/backend/wrangler.email.toml` (the `send_email` binding `EMAIL`
   and the `pas-email-events` consumer) and creates the queue.
3. Email Sending: onboard each domain (Compute > Email Service > Email Sending > Onboard Domain).
4. Queues: subscribe Email Sending events (delivered, bounced, complained; add deferred, failed, rejected for
   history) for each domain to `pas-email-events`.
5. Email Routing: for each inbox address, a rule with action "Send to a Worker" targeting the backend worker.
   **Before** an address is switched from forwarding to the worker, add the owner's mailbox as a verified
   destination address and set the copy-forward on its domain as administrator:
   `POST /v1/admin/email/domains/<domain>` `{ "forwardCopyTo": "<mailbox>" }`. Otherwise the owner stops
   getting the mail the moment the rule changes.
6. As administrator, attest each domain: `POST /v1/admin/email/domains/<domain>` `{ "verified": true }`.
7. The app owner claims the domain and approves the identity.

## MCP tools

An owner's AI client sets up app email through the platform MCP server (`mcp.proappstore.online`). Each
tool calls the routes above with the connection's own session, so the same owner, editor and
administrator checks apply for whichever account (GitHub or Google) the connection signed in with.
Refusals come back as `API <status>: <body>` with the route's stable `code` unchanged. There is no send
tool and no `from`: sending stays with `pas.email.send` in the app.

| Tool | Params | Route | Who |
|---|---|---|---|
| `app_email_status` | `app_id` | `GET /apps/:appId/email` | owner |
| `app_email_claim_domain` | `app_id`, `domain` | `POST .../email/domains` | owner |
| `app_email_declare_identity` | `app_id`, `address`, `display_name?`, `reply_to?` | `POST .../email/identities` | owner, editor |
| `app_email_approve_identity` | `app_id`, `identity_id`, `allow_external` | `POST .../identities/:id/approve` | owner |
| `app_email_revoke_identity` | `app_id`, `identity_id` | `POST .../identities/:id/revoke` | owner |
| `app_email_list_sends` | `app_id`, `limit?` (1-200, default 50) | `GET .../email/sends` | owner, editor |
| `app_email_list_suppressions` | `app_id` | `GET .../email/suppressions` | owner |
| `admin_email_attest_domain` | `domain`, `verified`, `forward_copy_to?` (null clears) | `POST /admin/email/domains/:domain` | platform admin |

The sends and suppressions routes have no cursor: sends take `limit`, suppressions return the newest 500.
