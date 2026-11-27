---
description: "Proposed signed-in developer marketplace: licensed app snapshots, purchase recovery, isolated provisioning and phased delivery (#691)."
---

# Developer marketplace design

**Status: proposal, 27 November 2026.** Design deliverable for [#691](https://github.com/proappstore-online/platform/issues/691), with the ownership and evidence contract in [#692](./marketplace-contribution-evidence.md). Neither document enables sales, forks, money movement, new grants or public identity disclosure. Follow-up work packages below are proposed issue specifications, not filed issues or approved commercial terms.

The intended product is a marketplace inside the signed-in Creator Console. An eligible owner offers a licensed, versioned copy of an app. A buyer gets a separate app and development workspace, and can continue through the existing prompt/build workflow. The original app and its resources stay with its owner. This is separate from the consumer storefront and from `template-marketplace`, which is an approved scaffold for building a two-sided marketplace app.

## Constraints and decisions

[#381](https://github.com/proappstore-online/platform/issues/381) records the owner decision that PAS has **no payouts, transfers or revenue sharing**. The implementation keeps `PAYOUTS_ENABLED = false` in `packages/backend/src/lib/payouts-flag.ts:8`; archived payout modules are not a marketplace dependency. This design introduces no seller balance, commission split, payout onboarding, settlement or payout decision. Stale subscription-pool wording elsewhere is not authority to reactivate them.

This creates a product constraint: setting an asking price must not imply that PAS remits proceeds to the app owner. Before paid launch, the commercial offer must explicitly explain who sells the license and receives the charge within the existing no-payout policy. The proposed first phase is private catalogue and synthetic purchase/fulfilment validation. A platform-revenue paid-copy offer is one possible later model, requiring an approved offer and owner agreement; it is not assumed here. If that model is unsuitable, paid launch remains disabled. There is no proposed payout work package.

| Question | Proposed baseline for implementation review | Decision required before paid launch |
| --- | --- | --- |
| What is purchased? | One pinned, reviewed source/assets snapshot and one destination workspace; preserve the original | Exact license text, permitted deployment/use, modification, redistribution and resale |
| Updates and support | No automatic tracking of the source app; show purchased version | Whether any update/support promise exists and its duration |
| Seller authority | Current technical owner plus separately reviewed authority to license every included component | Who reviews evidence, required agreement and dispute process |
| Asking price | Integer minor units and explicit currency, immutable per offer version; no client-supplied checkout amount | Allowed currencies, amount limits, taxes and final price presentation |
| Fees and money | Record charged/refunded amounts and provider fees separately; no seller payable | Any buyer-facing platform fee and who bears it; no assumed percentage |
| Refunds | Failed fulfilment supports reconciliation and refund workflow; access state distinct from money state | Refund window, partial-refund treatment, downloaded-source consequences and dispute handling |
| Destination resources | New owner/resources; fresh IDs, integrations off; build execution explicit | Included hosting/build allowance and spending limits |
| Publication | Signed-in developer listing only, explicit per-listing profile consent | No change to anonymous consumer-store policy |

These are product-contract decisions, not legal conclusions. Implementation can validate the state machines with synthetic terms; production purchase is gated until the actual terms are versioned and accepted.

## Verified baseline and gaps

Source was inspected at platform revision `7d888589e4165dc005a67a54b574858bf3e4d752` and Console revision `e93c746c294f2a75285bc676929e3ffc64ece3aa`. Paths below are relative to platform unless a repository is named. Line numbers identify the inspected baseline, not a promise that future lines remain fixed.

| Existing boundary | Evidence | Reuse and gap |
| --- | --- | --- |
| Console navigation | `proappstore-online/console`, `web/src/nav.ts:3`, `:23`; `web/src/NewAppModal.tsx:8` | Existing app workspace and template choices; the template called Marketplace is not an app-purchase screen. Add a distinct top-level developer marketplace. |
| New prompt project | Console `web/src/App.tsx:192`; `packages/agent-teams/src/index.ts:242`, `:286` | Creation currently posts name/slug/idea/template and chat is project-scoped. Buyer project must attach the fulfilled snapshot, not start another blank/template app. |
| Provisioning | `packages/admin/src/publish.ts:636`, `:755`, `:923`; `packages/admin/src/provision-workflow.ts:32` | Reuse validation, platform-owned repository creation, durable steps and deploy verification. Add a licensed-snapshot source type; never call an arbitrary repository-copy URL supplied by a buyer. |
| Template provenance and retries | `packages/mcp/src/provisioning-workflow.ts:6`, `:157`; `packages/backend/src/lib/provision-operation.ts` | Existing intent hashes, receipts and verified template trees are useful patterns. They do not prove a seller snapshot is licensed or safe. |
| GitHub primitives | `packages/build-core/src/github.ts:174`, `:189`, `:239` | Repository creation and file commits exist. An approved app snapshot is not automatically an approved template. Use a reviewed import path and do not register every seller as a template. |
| Customer payments | `packages/backend/src/routes/app-billing.ts:76`, `:144`; `packages/backend/src/lib/app-billing-handler.ts:29`, `:85` | Existing app-product checkout, provider idempotency, event facts and environment isolation are references. An app entitlement is not a source-copy license; keep marketplace orders separate. |
| Ownership and identity | [ADR-013](./adr/013-team-accounts.md); `packages/backend/src/lib/public-team.ts:91` | Account foundation and legacy app gates coexist. Read actual deployed authority; never assume account cutover, merge provider identities or treat profile labels as ownership. |
| Contribution evidence | [Contributions](./contributions.md), `packages/backend/src/routes/contributions.ts:29` | Private app statistics exist. Marketplace viewers gain no permission to read them; use the explicitly reviewed projection in the companion design. |

Read-only production observations on 27 November 2026: `GET https://api.proappstore.online/health` returned `200 {"ok":true}`; an unauthenticated GET to the **proposed** `/v1/developer-marketplace/listings` returned `404`. This only establishes those responses. It does not establish authenticated purchase readiness, Stripe configuration, account cutover, or absence of some differently named feature. No private account, repository contents or payments were probed.

## User journeys

### Owner offering an app

1. In the app's Develop workspace, open “Offer a copy”. The server checks current app authority using the deployed authorization boundary and first-party identity. A collaborator's code contribution alone does not qualify them.
2. Select a source revision from the app's verified immutable repository binding. Describe the copy, choose allowed asking-price/currency inputs, and select licensed assets. The server generates a manifest and digest. Do not expose private Git history to marketplace visitors.
3. Review dependencies, licenses, embedded identifiers, migrations/seed data and the exact include/exclude manifest. Resolve blocked assets or integration requirements. A scan is supporting evidence, not proof of license ownership.
4. Complete the team-rights review described in the companion design. Each required rights holder consents to the exact offer/snapshot/license version; each displayed person's separate visibility consent is optional. Missing consent or a dispute blocks activation.
5. Preview the developer listing, price/terms, included capabilities, setup requirements, snapshot date and reviewed owner display. Submit for moderation. Activation is an explicit audited operation; publication to the consumer storefront is never a side effect.
6. Edit by creating a new offer version. Existing purchases retain the old version. Withdrawing stops new checkout; it does not rewrite paid receipts or erase buyers' rights.

### Buyer receiving a copy

1. Sign into the Console; browse/filter signed-in listings and inspect the licensed contents, setup work, price, terms and reviewed owners. No source, contributor ledger, secrets or seller customer data is returned.
2. Choose a fresh destination app ID and destination account the caller may create resources in. Verify name availability, resource readiness and any required identity before checkout. Reserve the ID for this order; reservations expire safely.
3. Confirm the exact quote and license version. The UI says “Buy a copy”, shows what is included and makes no ownership-of-the-original or future-earnings claim. A client redirect never proves payment.
4. After server-confirmed payment, show “Payment received — preparing your app” and durable step progress. Reloading resumes the same order. A failed step shows retry/review status, not another Buy button.
5. Once the destination is verified, open the buyer's Develop workspace. Source provenance is recorded privately. The buyer separately configures new integrations, consents to access, and starts prompts/builds under their own cost controls. No seller project history, chats or agent execution is inherited.

### Review and moderation

Use a dedicated reviewer permission for listing review and for refund/reconciliation operations; never infer it from seller role or ordinary app admin access. Record reasons, previous state, actor and expected version. A takedown blocks new sales and unstarted fulfilment, preserving receipts for review. Do not claim that an already delivered source copy can be remotely recalled. Notify users through in-product order state; any email delivery is a separately configured channel with explicit purpose and recipient rules.

## Proposed boundaries and data model

Platform backend owns listing authorization, offer versions, quote/order/license records and purchase facts. Private R2 storage owns content-addressed sanitized snapshots. The admin provisioning workflow owns destination creation and resumable fulfilment. Agent Teams owns the buyer's new development project. Console is a consumer of these contracts. The consumer storefront and its static catalogue stay independent.

All table names below are proposals; no migration number is reserved by this document. Use additive migrations with shared numbering coordinated in one lane. Persist immutable identities and timestamps, never secrets or payment credentials.

| Record | Required facts and invariants |
| --- | --- |
| `developer_listings` | ID, source app, authoritative owner reference/version, lifecycle, current offer version, reviewer state. Draft/private by default. |
| `developer_offer_versions` | Listing/version, title/description, price minor units/currency, exact source repository ID/SHA, snapshot digest, license document digest/version, rights-review ID, approved display projection version. Published versions immutable. |
| `developer_snapshots` | Manifest digest, private storage key, original and sanitized tree digests, transformation-policy version, license inventory, bounded sizes, scanner/reviewer evidence. Read access never implied by knowing digest. |
| `developer_orders` | Opaque ID, authenticated buyer and destination owner, offer version, quote amount/currency, environment, intent hash, request key, payment state, fulfilment state, terms acceptance, timestamps. Unique `(buyer, environment, request_key)`; key reuse with different intent is 409. |
| `developer_payment_facts` | Verified provider account/environment/object IDs, amount/currency, event type and status; unique environment/event/object references; append or monotonic corrections. No seller payable. |
| `developer_license_grants` | Order, recipient, snapshot/license digest, granted/held/revoked-for-future-delivery state, effective times and reason. One grant per order; legal effect of refunds is defined by approved terms. |
| `developer_fulfilments` | Unique order, reserved destination ID, provisioning receipt, project ID, per-step artifacts, lease/attempt, source hash and verified result. A retry reuses the same destination. |
| `developer_marketplace_audit` | Append-only actor, action, subject, prior/new versions, safe reason and request correlation. No source contents or private contributor metadata in ordinary logs. |

The owner-at-offer-time is an audit fact, not current authority. Before accepting checkout and before starting fulfilment, recheck listing status, rights-review state, source availability and current authority/version. A source ownership change freezes unpurchased offers for review. Paid orders retain their evidence; uncertain authority moves fulfilment to review rather than silently transferring funds or substituting a version.

### Proposed API

Prefix: `/v1/developer-marketplace`. Names are proposed contracts, not available routes. Require a first-party signed-in person; team/account governance uses ADR-013 readiness and permissions, not an app-bound token. Every response is private/no-store. A logged-in buyer still has no access to another buyer's order or a seller's draft.

| Route | Boundary |
| --- | --- |
| `GET /listings` and `/listings/:id` | Active approved projection only; cursor/filter allowlist, stable ID tie-break, no arbitrary SQL/repository field |
| `POST /apps/:appId/listings` | Authorized owner creates draft; idempotency key and expected source-owner version |
| `POST /listings/:id/versions` | Owner creates immutable proposed snapshot/offer; bounded input, server repository binding |
| `POST /listings/:id/submit` / `/withdraw` | Version-checked lifecycle transition; submit is not approve |
| `POST /listings/:id/review` | Dedicated reviewer; reason, expected version, audit; approval cannot fabricate missing consent |
| `POST /quotes` | Buyer, offer version, destination; server derives amount/currency/license and expiry |
| `POST /orders` | Buyer accepts quote/terms; idempotency key; server gates test/live independently |
| `GET /orders/:id` | Caller-owned order and safe progress; no raw provider error or private repository credentials |
| `POST /orders/:id/retry` | Authorized resume of existing fulfilment only; cannot re-charge or change source/owner |
| `POST /orders/:id/refund-review` | Buyer requests review; distinct privileged refund execution and reconciliation |

The provider webhook is signature-verified by the platform and explicitly dispatched by marketplace metadata. Never let marketplace events fall through as app subscriptions or service balances. Bind provider object, account, environment, order, amount and currency before applying facts. Use a dedicated marketplace purchase reducer rather than extending an unrelated app's SQL authorization action to cover source licensing.

## Payment and fulfilment recovery

Payment and delivery are independent state machines. Proposed payment states: `pending`, `processing`, `paid`, `failed`, `refund_pending`, `partially_refunded`, `refunded`, `disputed`. Proposed fulfilment states: `not_started`, `queued`, `running`, `retryable`, `review_required`, `ready`, `cancelled`. States come from verified facts and guarded transitions; a late event cannot reset a refund or ready destination to an earlier state.

| Interruption | Required recovery |
| --- | --- |
| Order persisted; checkout request times out | Reconcile provider session by durable order/idempotency reference. Return same order; do not blindly issue another charge. |
| Checkout exists; local session link write failed | Webhook/provider reconciliation restores the link only after matching identity, environment and amount. |
| Duplicate/out-of-order webhooks | Unique event facts and deterministic reduction; duplicate successful payment queues at most one fulfilment. |
| Browser closes or redirect forged | Order read reports server state. Redirect neither grants source nor starts a fork. |
| Payment received; snapshot unavailable or rights disputed | Keep paid receipt, place delivery in review, offer supported refund process. Never substitute latest source. |
| Repository created; D1/route/project step failed | Durable receipt locates the same reserved destination; inspect and resume missing steps, verify ownership before reuse. |
| Worker lease expires during provisioning | Compare attempt generation and reconcile external resources; stale attempt cannot mark ready. |
| Refund races delivery | Serialize order transition; unstarted delivery is cancelled when appropriate. For already delivered source, apply approved refund terms and preserve audit; do not delete buyer work. |
| Marketplace disabled | Disable new listings/quotes/purchases; continue authenticated reads, reconciliation and safe recovery/refund processing for accepted orders. |

Provisioning is ready only when source digest, destination owner, fresh resource IDs, required build/deploy evidence and development-project binding are verified. A private repository creation response alone is not fulfilment. Reconciliation runs bounded batches with leases/backoff and reports stuck paid orders by age; a retry budget ending means review, never a forgotten paid order. Metrics cover payment/fulfilment lag and failures without source/person data.

## Snapshot and isolation contract

Copy only the reviewed licensed tree, without `.git` or seller history. Build an allowlist manifest with normalized relative paths, sizes, hashes, licensing evidence and transformation results. Reject traversal, symlinks that escape the tree, oversized archives and unsupported submodules/LFS assets until explicitly reviewed. Scan content as well as filenames: secrets or customer exports can live in ordinary source and seed files. A buyer must not choose a different repository/ref through request fields.

| May be copied after review | Must be regenerated, excluded or left disconnected |
| --- | --- |
| Licensed source, tests, reviewed schema migrations, genuinely synthetic seed data, permitted static assets and dependency declarations | Production D1/KV/R2 contents, user uploads, logs, backups, caches and analytics identifiers |
| Sanitized app manifests with documented placeholders | API keys, tokens, `.env`, OAuth clients/refresh tokens, signed URLs and embedded credentials |
| License notices and reviewed attribution text | Seller domains, DNS, billing products/customers, subscriptions, grants, memberships, roles and invitations |
| A build specification that passes current platform checks | Seller CI secrets, workflows with unreviewed permissions, hooks, schedules, connector bindings, app IDs and deployment credentials |

Generate the canonical platform workflow as in `buildAgentBundle`; do not execute the seller's workflow on import. Preflight package scripts and migrations in a restricted build environment without production credentials/network grants. A clean destination database still needs reviewed schema initialization; applying a seller migration that fetches data or contains personal seeds is not a clean copy. Record sanitized-tree differences so both sides can see what was excluded.

Create fresh app/repository/database/host route/storage namespace and a new buyer-owned Agent Teams project. Buyer app credentials cannot read the seller's resources, and seller credentials cannot administer the destination. Any required GitHub access uses existing verified identity and supported provisioning; if an additional connection is necessary, show that prerequisite explicitly. No implicit OAuth consent or copying collaborators. Forking is a product-level copy, not a GitHub fork-network membership promise.

## Proposed implementation work packages

Do not file these from the design task. Each package needs its own tracked issue before implementation; filenames are proposed ownership areas, not authorization for concurrent edits to shared files.

| Package and dependency | Deliverable and acceptance | Tests, rollout and rollback |
| --- | --- | --- |
| M1 — contracts and private catalogue; depends on accepted marketplace offer/privacy decisions | Add listing/version/draft-review API and Console browse/owner preview under a default-off gate; no checkout. Confirm proper app authority and signed-in-only projection; cross-link rights R2/R3 below. | Runtime tests for nonmember/app-token rejection, stale versions, withheld consent, removed owners and private data exclusion. Deploy additive backend before Console; gate off hides listing writes without losing drafts. |
| M2 — sanitized snapshot prototype; depends on M1 and evidence R1 | Verified app/repository/SHA binding, manifest and private artifact; deterministic sanitized digest with component/license review evidence. No actual buyer app. | Fixtures for malicious paths, hidden secrets, submodules, seed PII, source changes, dependency licensing omissions and hash mismatch. Revoke artifact access and stop snapshot jobs; retain safe audit. |
| M3 — isolated provisioning; depends on M2 and explicit synthetic provisioning authorization | Extend supported admin workflow with a licensed-snapshot source and durable order receipt; fresh destination resource ownership and buyer project. | Synthetic resources only; fail/restart every external step, collision/lease races, cross-owner access probes, digest verification, deploy gates. Stop new fulfilments; reconcile partial resources without deleting unrelated data. |
| M4 — purchase ledger and test-mode adapter; depends on M1, M2, approved synthetic terms | Separate marketplace orders, quote binding, payment facts, license grant and reconciliation. No live key fallback; no transfer/payout calls. | Deterministic provider fixtures then explicitly authorized controlled test principals/test provider mode. Duplicate/racing requests, amount/currency mismatch, webhook environment mismatch, unknown outcomes and refund-before-pay permutations. Gate checkout off; keep recovery reads/jobs. |
| M5 — Console buyer/owner journey; depends on M1–M4 and reviewed owners R3 | Accessible catalogue, preview, version/terms acceptance, durable progress, recovery and Develop handoff. Browser reload/account switch cannot leak an order. | Chromium/WebKit 320/390px, keyboard, session expiry, failed payment, paid-but-not-ready, destination collision, interrupted fulfilment and consent withdrawal. Feature gate with API compatibility preserved. |
| M6 — end-to-end readiness; depends on M3–M5 | One synthetic signed-in owner offer → test purchase → isolated app → prompt edit; private evidence bundle with exact revisions and receipts. Paid launch remains separately gated on commercial terms and readiness. | Assert zero source data/grants copied; no seller writes; no live payment/payout API calls. Exercise reconciliation and refund path. CI/deploy + live read evidence distinct; gate off is rollback, not destructive schema removal. |

Schema migrations, backend routing/types, provisioning primitives and workflow path changes must be serialized. Console work is a separate repo and adopts deployed additive contracts. Follow each repo's current verification bar and path-filtered deployment rules. No branch/PR or local deployment is needed for delivery.

## Design acceptance and evidence limits

This document covers #691's current design scope: source trace, offer/buyer flows, proposed data/API/UI, price/license questions, the preserved no-payout policy, refunds/recovery, isolated copying, and sequenced implementation/verification plans. The companion document covers reviewed owners and contribution evidence. No source-copy implementation, commercial agreement, actual purchase, provider readiness check or production fork is claimed by this design. Review the unresolved contract choices before enabling their dependent implementation stages.
