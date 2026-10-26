---
description: "Transfer app ownership through an offer and acceptance, or follow the platform-admin recovery process."
---

# App ownership transfer and recovery

Status: **shipped** (#423). An app's owner is `apps.creator_id`. It changes only
when a recipient accepts a transfer the owner offered, or when a platform admin
approves an escalated request. Nothing else moves it, including an app being
down, empty or unvisited.

Code: `packages/backend/src/routes/ownership.ts` (API),
`packages/mcp/src/ownership-tools.ts` (MCP), `migrations/0105_app_ownership_transfers.sql`.

## Two kinds of request

| Kind | Filed by | Starts as | Moves ownership when |
|---|---|---|---|
| `transfer` | the current owner, naming a recipient | `pending` (expires after 7 days) | the recipient accepts, or an admin approves it after escalation |
| `recovery` | a signed-in non-owner who says they created the app under another sign-in | `escalated` | an admin approves it |

## State machine

```
transfer:  pending ──accept──────────▶ accepted
              │ ├──decline─────────▶ declined
              │ ├──cancel (sender)─▶ cancelled
              │ ├──7 days pass─────▶ expired
              │ └──escalate────────▶ escalated
recovery:                              escalated ──admin approve──▶ admin_approved
                                           │ ├──admin reject───▶ declined
                                           │ └──cancel─────────▶ cancelled   (sender of a transfer / requester of a recovery)
```

- A pending row past its expiry is marked `expired`, and audited, the first time
  anyone touches it. Accepting or declining it then returns `410`. An expired
  pending transfer can still be escalated: that is the stuck case.
- When ownership moves, every other open row for the app is closed as `cancelled`
  and audited as `superseded`. Those rows were all about the previous owner.
- The move is one D1 batch. It applies only while the row is still in the expected
  state (and unexpired), and only while the app is still owned by `from_user`.
  A replayed or racing accept is `409` and changes nothing.

## Who can do what

| Action | Route (`/v1`) | Who |
|---|---|---|
| Read status | `GET /apps/:appId/ownership` | any signed-in user (each sees their own view, below) |
| Offer the app | `POST /apps/:appId/ownership/transfer` `{ to, message?, dry_run? }` | the creator only: not a team `owner`, not an admin acting for them |
| Accept / decline | `POST …/transfer/:id/accept` · `…/decline` | the recipient |
| Cancel | `POST …/transfer/:id/cancel` | the sender of a transfer; the requester of a recovery. The owner cannot cancel a recovery filed against them. |
| Escalate | `POST …/transfer/:id/escalate` `{ reason? }` | either party to a pending transfer |
| Request recovery | `POST /apps/:appId/ownership/recovery` `{ evidence }` | any verified non-owner; one open request per person per app |
| Resolve | `POST /admin/apps/:appId/ownership/transfer/:id/resolve` `{ action: approve\|decline, reason }` | a platform admin (session role `admin`) |

**Verified identity.** A recipient or recovery requester must have signed in with
GitHub or Google. Child accounts and username/password accounts are refused.
`to` may be a PAS user id, an email or a GitHub login. An unknown, unverified or
ambiguous recipient (for example, one email shared by two accounts) gets the same
`400` message and no row is created, so the endpoint cannot be used to learn
which emails have accounts.

**Implications.** Before anyone confirms, the owner sees what changes hands:
the repository (it stays in `proappstore-online`), the route and custom domains,
the data worker and its database, the app worker, active CI session grants, team
size, and active licences/billing. `dry_run: true` returns this and writes
nothing. The same snapshot is stored on the row and shown to the recipient.

## What each party sees

Other people appear by **login only**: never by email, provider id or user id.
Only admins see user ids. The status response is always `Cache-Control: private, no-store`.

| Viewer | Sees |
|---|---|
| Not a party | `you: "none"`, `owner: null`, `can_request_recovery: true`, and nothing about the owner or any request |
| Owner | their transfers and the other party's login; that a recovery request exists, **not who filed it**; recovery evidence is `[withheld]` |
| Transfer recipient | the sender's login, the implications, the expiry |
| Recovery requester | their own request; **not** the owner's login and **not** the implications |
| Previous owner | their completed transfer and its audit trail, even after losing the app |
| Admin | everything, including user ids and the evidence |

Notifications are best-effort emails, each sent to the user's own address. A mail
failure never fails the action; the audit record is what lasts.

## Audit record

`app_ownership_audit` gets one row per transition: `initiated`, `accepted`,
`declined`, `cancelled`, `expired`, `escalated`, `recovery_requested`,
`admin_approved`, `admin_declined`, `superseded`.

| Field | Meaning |
|---|---|
| `app_id`, `transfer_id` | what it is about |
| `actor` | user id who acted, or `system` (expiry, superseding) |
| `action` | the transition |
| `from_user`, `to_user` | the parties of the row |
| `detail` | JSON: expiry, message, reason, evidence |
| `created_ms` | when |

The table is **append-only**: `BEFORE UPDATE` and `BEFORE DELETE` triggers abort
with `audit records are immutable`. It has no foreign key, so it outlives the
app. Transfer rows cascade with the app; audit rows stay. In the status view,
actors are labelled `you`, `sender`, `recipient`, `platform admin` or `system`.

## Admin resolution rules

- Only `escalated` rows can be resolved. A `reason` is required and is shown to both parties.
- An admin cannot approve a move to themselves. Another admin must do it.
- Approval is refused (`409`) if the app changed owner after the request was filed.
  Decline it and have the requester file a new one.
- A recovery is never approved because an app is down or empty. It needs evidence that
  the requester created the app: the other sign-in, the repository, commits.

## MCP tools

On the shared `/mcp` endpoint. Each calls the routes above with the connection's
own session; mutating calls are audited and blocked in read-only mode.

| Tool | Does | Safety |
|---|---|---|
| `ownership_status` | the caller's view of the app's ownership, as above | read-only |
| `request_ownership_transfer` | offer the app; without `confirm` it shows the implications | **confirm**, **dry_run** |
| `respond_ownership_transfer` | `accept`, `decline`, `cancel`, `escalate` | **confirm** + **dry_run** for `accept` |
| `request_ownership_recovery` | file a recovery request with evidence | audited |
| `resolve_ownership_request` | admin `approve` / `reject` with a reason | **confirm** for `approve` |

## Decisions

- **Users, not organisations.** PAS has no organisation entity, so a transfer goes to
  one verified user. Transfer to an organisation waits for one to exist.
- **No step-up re-authentication.** MCP sessions are re-minted from their original
  claims and can never be "recent", so a step-up gate would close the MCP flow. The
  safeguards are two-party consent, expiry, verified identities and the guarded move.
- **The previous owner keeps no access** unless the new owner adds them to the team.
