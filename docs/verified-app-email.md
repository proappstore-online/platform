# Verified app email

An app sends and receives mail on **its own domain** through the platform (#566). The platform
owns the sender identity, the send, the idempotency, the quotas and the events; the app owns
which sender to use, its templates and approval rules, and matching a reply to its own records.
Nothing here is specific to one app.

It is inert until the platform has a Resend account: without `RESEND_API_KEY` every call answers
`email_not_configured` (HTTP 503 / worker `Unavailable`) and makes no provider call. The older
`app.email.send` (platform sender `noreply@proappstore.online`, 100 a day) is unchanged.

## The model

1. **Claim a domain.** The owner posts the domain; the platform registers it with the provider and
   returns the DNS records to add. The domain is usable only after the provider confirms those
   records (`verify`), which is the proof of control. A domain belongs to one app: a domain verified
   by another app is refused (`domain_taken`); an unverified claim does not block anyone, it is
   displaced by the next claimant. `proappstore.online` and its subdomains cannot be claimed.
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
| `GET /apps/:appId/email` | owner | `{ configured, suspended, limits, usage, domains[], identities[] }`; domains carry the DNS records; no secret anywhere |
| `POST /apps/:appId/email/domains` `{ domain, receiving? }` | owner | 201 domain + records. `receiving: true` also asks for inbound (adds an MX record) |
| `POST /apps/:appId/email/domains/:domain/verify` | owner | re-checks DNS with the provider |
| `DELETE /apps/:appId/email/domains/:domain` | owner | revokes its identities |
| `POST /apps/:appId/email/identities` `{ address, displayName?, replyTo? }` | owner, editor | 201, `pending` |
| `POST /apps/:appId/email/identities/:id/approve` `{ allowExternal? }` | owner | |
| `POST /apps/:appId/email/identities/:id/revoke` | owner | |
| `POST /apps/:appId/email/send` | owner, editor | see below; 201 new, 200 replay |
| `GET /apps/:appId/email/sends[/:id]` | owner, editor | the platform's send records and their events |
| `GET /apps/:appId/email/suppressions` | owner | |
| `POST /admin/email/apps/:appId` `{ suspended, reason?, dailyLimit?, identityDailyLimit?, burstLimit? }` | admin | kill switch and quota overrides (null = default) |
| `POST /admin/email/apps/:appId/identities/:id/suspend` `{ suspended, reason? }` | admin | |
| `POST /email/provider-events` | the provider | Svix-signed webhook; 401 unless the signature verifies, 503 until `RESEND_WEBHOOK_SECRET` exists |

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
final for that key) or `unknown` (no answer; retry with the same key, which cannot send twice).
`createdAt` and `acceptedAt` are server times in epoch milliseconds.

Idempotency: the same key and message returns the same record (`replayed: true`) and never sends
again, including after an `unknown`. The same key with a different message is `idempotency_conflict`.
Provider-side the key is `pas-<record id>`.

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
`domain_not_claimed` `domain_taken` `domain_reserved` `address_taken` `not_found` `provider_error`.
In a worker the class is `Forbidden` (all refusals), `BadRequest` (`invalid_request`,
`idempotency_conflict`), `RateLimited` (quotas), `Unavailable` (`email_not_configured`), `NotFound`,
`Failed`; the message is `<Class>: <code>[: detail]`.

## Events

The platform verifies the provider's signature, de-duplicates on the provider event id, attributes the
event to its app, and gives the app's worker a **hook event** through the app-events queue (at least
once, retried with backoff, dead-lettered). The envelope `id` is stable across retries: handle each
once. `event.name` is the hook name; `event.hook.body` is JSON (`emailEventOf(event)` in
`@proappstore/sdk/worker` parses it). The app does not declare these hooks in `mcp.json`.

| `event.name` | Body |
|---|---|
| `pas.email.delivered` | `{ type, id, sendId, providerId, from, to[], occurredAt, suppressed: false }` |
| `pas.email.bounced` | the same plus `permanent` and `bounce: { type, subType, message }`; `suppressed` is true for a permanent bounce |
| `pas.email.complained` | the same, `suppressed: true` |
| `pas.email.inbound` | `{ type, id, receivedAt, identity: { id, address }, providerId, messageId, from, to[], subject, text, html, truncated, headers: { in-reply-to, references, reply-to, date }, authentication: { spf, dkim, dmarc } \| null, attachments: [{ id, filename, contentType, size, quarantined: true }] }` |

History is appended, never rewritten: `GET .../sends/:id` and `pas.email.get(id)` return the record with its
`events`, and `deliveredAt` / `bouncedAt` / `complainedAt` are set once. An event for a message the
platform did not send through this feature is ignored. Inbound mail is routed only to an approved,
unsuspended identity on a verified domain of an app that is not suspended; other mail is acknowledged and
dropped. Trust `authentication`, never the From header or a display name. Attachment bytes are never
delivered (metadata only, quarantined). Bodies over 200,000 characters are cut and `truncated` is true.

## Retention and deletion

Send records, their events, suppressions and inbound metadata (no bodies) are kept until the app is
deleted; there is no automatic pruning yet. Hook deliveries of these events follow the hook rule (14
days). The provider keeps message logs for 30 days (Resend, all plans) and received mail and attachments
on its side; deleting an app's records does not delete the provider's copy. Inbound bodies are not stored
by the platform in this version.

## Going live

See the issue #566 hand-off for the owner steps: a Resend account, the secrets `RESEND_API_KEY` and
`RESEND_WEBHOOK_SECRET` (`whsec_...`) on the backend worker, a webhook to `/v1/email/provider-events`
subscribed to `email.delivered`, `email.bounced`, `email.complained` and `email.received`, and the DNS
records `GET /v1/apps/:appId/email` returns per domain.
