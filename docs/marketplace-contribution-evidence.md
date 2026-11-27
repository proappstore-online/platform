---
description: "Proposed reproducible contribution evidence and reviewed owner consent for developer marketplace listings (#692)."
---

# Contribution evidence and reviewed marketplace owners

**Status: proposal, 27 November 2026.** Design deliverable for [#692](https://github.com/proappstore-online/platform/issues/692), paired with the [developer marketplace design](./developer-marketplace-design.md) for #691. It introduces no contribution ledger, owner role, legal share, payout entitlement or public contributor data. Proposed commands, tables and APIs below do not yet exist.

The product needs two separate records: a reproducible account of repository activity, and a reviewed statement of who may authorize a particular licensed app offer. Activity can inform review; it never decides ownership. Code review, product work, design, documentation, marketing, maintenance and purchased assets can matter even when the line-counting policy measures none of them.

## Existing contracts to reuse

Source audit baseline: platform `7d888589e4165dc005a67a54b574858bf3e4d752`, Console `e93c746c294f2a75285bc676929e3ffc64ece3aa`. The existing LOC implementation was inspected, not rebuilt. [#544](https://github.com/proappstore-online/platform/issues/544) is the parent; #545/#546/#547 cover ledger/ingestion/API, #556 covers deployed scheduling acceptance, and [Console #13](https://github.com/proappstore-online/console/issues/13) is the existing consumer. Issue closure or a code path is not proof of live completeness for a selected app.

| Source | Existing guarantee or limitation |
| --- | --- |
| `migrations/0132_project_contributions.sql:12`, `:30`, `:58` | Verified repository binding; one commit fact per immutable GitHub repository ID and SHA; separate sync/checkpoint metadata. `reachable` describes the current walk, not historical reachability at every SHA. |
| `packages/backend/src/lib/contributions/policy.ts:16`, `:43`, `:57` | Policy v1 source/test path rules and per-file totals. Documentation, lockfiles, generated/vendor output and missing diffs are excluded. |
| `packages/backend/src/lib/contributions/ingest.ts:34`, `:129`, `:222` | Server derives repository; bounded pinned-head walk and rewrite reconciliation; facts persist alongside mutable reachability. |
| `packages/backend/src/lib/contributions/github.ts:63`, `:97` | Immutable repository API reads and paged commit files; absent provider-linked author becomes unlinked; truncated file coverage is recorded. |
| `packages/backend/src/lib/contributions/stats.ts:23`, `:98`, `:138`, `:167` | Honest freshness/state, half-open author-date period, people/bot/unlinked denominator, stable ranking and paginated people. Current aggregate reads are separate queries over a changing ledger. |
| `packages/backend/src/routes/contributions.ts:29`, `:36`, `:49` | Viewer-or-higher reads, private/no-store, owner-only refresh. Listing visibility does not grant these reads. |
| Console `web/src/nav.ts:23`; [contributions API](./contributions.md) | Existing per-app Contributions view is the private statistics consumer; reuse its presentation semantics. |
| `packages/backend/src/lib/public-team.ts:52`, `:65`, `:104`; [public-team contract](./public-team-projection.md) | Own saved visibility and minimal opted-in current-member display; labels are presentation, not ownership. |
| [ADR-013](./adr/013-team-accounts.md) | Current authority and account cutover readiness remain distinct from historical `creator_id`, identity and public profiles. Never infer provider-account links. |

The source supports current-head historical activity; it does not yet support a stable, paginated report pinned to any requested older SHA. A complete ledger may change while summary and people pages are read. A report must not label such mixed reads “reproducible at SHA X”. This is the main analysis-prototype gap, not a reason to create a second LOC database.

## Metric and interpretation

### Baseline: historical additions

For verified author `u`, snapshot head `H`, and period `[F,T)` in UTC:

`A(u,H,F,T) = sum(eligible additions of non-merge commits reachable from H, attributed to u, with F <= authorDate < T)`.

Show additions, deletions, eligible commit count and last eligible commit date separately. Share is `A(u) / sum(A(all people, bots and unlinked))`, with zero denominator displayed as zero and explicitly empty only if history is complete. Keep raw integers; round displayed percentages only. Rank additions descending, immutable GitHub account ID ascending. Do not relabel additions as remaining code, quality, effort, legal ownership or salary.

The first report uses policy v1 and simple date filters. This is understandable and directly comparable with #544. Large formatting changes and churn remain activity; flag limitations rather than silently inventing a quality score. An optional future surviving-line/blame report would need a different named policy and fixtures; it is not part of v1 and is not interchangeable with additions minus deletions.

### Optional recency comparison

Offer an explicitly labelled analysis column, not the primary leaderboard or an ownership recommendation. Proposed policy `recency-v1` fixes the evaluation time to `T` and takes a declared positive half-life `h` in days:

`ageDays(c) = max(0, (T - authoredAt(c)) / 86_400_000)`

`weight(c) = 2 ^ (-ageDays(c) / h)`

`weightedAdditions(u) = sum(eligibleAdditions(c) * weight(c))`.

Weighted share uses the same denominator buckets and selected period. Use full-precision computation and round only output; store formula version, `T`, `h` and calculation-engine version. Display plain and weighted totals side by side, with no “percent owner” label. With `h=90`, 100 lines authored one day before `T` and 100 lines authored 91 days before `T` have weights in a 2:1 ratio: weighted shares are 66.67% and 33.33%, while unweighted shares are 50% each. This illustrates the bias, not a recommended ownership split. Commits exactly at `T` are excluded by the half-open period.

Recency favors recent churn and can undervalue foundational work. Author dates are not verified labor dates and can be manipulated. Report future/invalid dates; do not let clamping erase anomalies. Half-life is a report parameter for review, not a mutable global reward setting. No live weighting is needed for the first prototype.

### Edge-case policy

| Case | Required treatment |
| --- | --- |
| Renamed login or multiple author emails | Use numeric GitHub account ID from provider attribution; no name/email matching. Aliases only group when the provider reports the same immutable ID. |
| Co-author trailers | Count co-authored commits as a limitation; current policy credits the linked primary author once. Never give everyone full credit. Store no raw trailer emails in output. |
| Squash/rebase | Count reachable recorded commits once; lost pre-squash attribution is unknown. A rewritten SHA is a new historical fact and old unreachable facts leave the selected report. |
| Merge | Exclude merge commit diff; count reachable non-merge ancestors once. Do not walk first-parent only. |
| Rename or mode-only change | Pure zero-line rename/mode change contributes no lines; changed content follows the same provider file-diff/path policy. Local rename heuristics may differ and require a reported mismatch. |
| Revert/reformat/churn | Historical additions/removals remain visible. Never use net additions as surviving ownership; report known coarse-metric limits. |
| Generated/vendor/docs/locks/binary | Use the actual shared policy predicates; tests count, docs do not. A local adapter must not count a file the provider excluded for missing patch. |
| Bots | Separate automation bucket; included in denominator. Never turn automated commits into a human owner's contribution. |
| Unlinked author | Separate unlinked bucket. Cannot be resolved through a guessed name/email/PAS account. |
| Missing history, shallow clone, truncation, access failure | Mark incomplete, unavailable or mismatch with reasons; retain observed counts without claiming exactness. No guessed zero. |
| New commits during report generation | Head/time window fixed before generation; either read one committed snapshot revision or retry. Never mix people pages from different ledger states. |
| Policy change | New explicit counting version; recompute or refuse mixed facts. Preserve earlier report identity and mark superseded results. |

## Read-only report prototype

Proposed command shape, not an existing CLI feature:

```text
pas contributions report --app <authorized-app> --head <exact-sha> \
  --from <utc-start> --to <utc-exclusive-end> --format json
pas contributions compare --app <authorized-app> --head <exact-sha> \
  --local <already-authorized-clone> --report <private-report.json>
```

Server resolves the repository from the app and checks existing contribution-read permission. An app ID, local path or SHA grants no additional access. Do not accept an arbitrary remote URL or fetch unrelated repositories. Use existing connections only. A local comparison does not write repository history, refresh platform facts, invoke a build, store new credentials or upload private source. If the required facts are missing, the command reports that fact; an existing authorized refresh is a separate action.

### Consistent evidence without a competing ledger

1. Capture verified app/repository identity, requested SHA, policy, report bounds and sync revision. Reject an unverified repository binding or inaccessible object. Initially support only the fully reconciled current head; explicitly refuse older heads rather than approximate them.
2. Generate the report against a transactionally consistent completed ingestion generation. Add a monotonic ledger revision/generation to the existing contribution subsystem if needed. Do not rely solely on a lease check before separate queries: a writer can start after the check.
3. Produce a private immutable report artifact containing aggregate/people rows and a commit-membership digest derived from the existing facts. This is an evidence snapshot, not a second mutable source of truth. Its version token also binds pagination; a changed generation causes a retry or a new report, not a mixed page.
4. For later arbitrary-head support, derive and verify reachable SHAs at that head using the existing authorized GitHub source and existing `(repository, SHA)` facts. Missing facts or incomplete ancestor traversal refuse exact status. Do not reinterpret current `reachable=1` as reachability at an older head.
5. Hash canonical report inputs and calculation output separately from volatile generated-at metadata. Include schema/canonicalization version so repeated runs compare meaningful bytes. Keep reports private with the app's current access checks; revocation stops retrieval even for an old report ID. Retention/deletion must not become a backdoor permanent contributor directory.
6. A local adapter verifies clone identity/head and history depth, traverses all reachable commits with explicit diff options, reuses `policy.ts`, and compares per-commit totals to the server. It cannot infer verified numeric authors from Git emails. Unavailable identity mapping stays unlinked/unverified; do not silently make local output authoritative. Provider patch omissions, truncation and rename differences are explicit deltas.

Proposed report fields:

```json
{
  "schema_version": 1,
  "report_id": "opaque-private-id",
  "app_id": "synthetic-app",
  "repository_id": 123,
  "head_sha": "exact-verified-commit-sha",
  "ledger_generation": 42,
  "period": { "from": "2026-01-01T00:00:00Z", "to": "2026-11-27T00:00:00Z" },
  "counting_policy": 1,
  "recency": null,
  "coverage": { "state": "complete", "truncated_commits": 0, "missing_commits": 0 },
  "confidence": { "counts": "reconciled", "identity": "provider-linked-with-unlinked-bucket", "ownership": "not-assessed" },
  "totals": { "additions": 100, "deletions": 15, "commits": 4 },
  "buckets": { "bots_additions": 10, "unlinked_additions": 10 },
  "people": [{ "github_account_id": 501, "additions": 80, "deletions": 15, "commits": 2, "share_numerator": 80, "share_denominator": 100 }],
  "commit_set_digest": "sha256:<digest>",
  "result_digest": "sha256:<digest>",
  "limitations": ["historical activity only; no ownership inference"]
}
```

Values are illustrative. Private report IDs, repository IDs and numeric contributor IDs are excluded from marketplace listing payloads. Confidence is a set of evidence states, not an invented numerical certainty score. `complete` means commit/file traversal coverage under this policy, not legal completeness or proof that all contributors were identified. Show unlinked/truncated counts prominently.

## Reviewed authority and consent

Model four distinct concepts: technical resource owner, claimed rights holders, signatories authorized to license this snapshot, and people who consent to be displayed. A team can have several reviewed rights holders while the current app still has a single legacy `creator_id`. Do not mutate that technical ownership or issue account roles as a side effect of review.

Proposed process:

1. Current authorized app owner opens a rights review for an exact offer/snapshot/license digest. They name proposed rights holders using verified existing identities and attach references to supporting agreements in a private evidence store. An LOC report is optional supporting evidence; no threshold selects the owners.
2. Record claimed scope, authority basis, source/asset coverage, effective date and version. Capture non-code evidence separately with author/submitter and provenance, not as fabricated line credits. Do not store ownership percentages or payout allocations in this first model.
3. Required signatories review the precise offer. A first-party session and appropriate recent-authentication check binds each consent to the review, license and snapshot digest. No consent by proxy, unchecked preselection or inferred consent from project membership/public profile visibility.
4. Dedicated reviewer records acceptance or refusal with reasons and evidence references. Approval requires every required consent and no open dispute. The reviewer cannot waive a missing signature by relabelling a contribution metric.
5. Changing a material term, source snapshot, rights-holder set or licensing scope creates a new review and requires relevant consent again. Technical ownership transfer also suspends new listing sales pending authority recheck. Preserve old order evidence.
6. Each person independently permits a minimal display name/label for this signed-in marketplace audience. Existing public-team opt-in is not blanket consent to “owner” status or a new audience. A hidden person may still be a required private signatory.
7. Withdrawal of display consent removes their projection promptly; withdrawal of licensing consent before sale suspends new offers. Treatment of existing grants follows the agreed license, with recorded effective dates rather than silent retrospective rewriting.
8. A disputed claim freezes new sales and sends pending fulfilment to review. An override requires a designated reviewer, reason, scoped replacement evidence and a new review version. It never changes historical Git facts or creates automatic economic rights. Preserve both prior and superseding decisions for authorized audit.

Proposed tables are `developer_rights_reviews`, `developer_rights_participants`, `developer_rights_consents`, `developer_rights_decisions`, `developer_owner_display_consents` and `developer_rights_disputes`. Use opaque IDs, version/expected-version checks, append-only decisions, immutable consent subject digests and separate effective/recorded timestamps. Required fields include actor identity, verified subject identity, scope, evidence reference, status and version. Raw contracts and disputes are never included in ordinary listing reads or agent logs.

Review API proposals under `/v1/developer-marketplace/listings/:id/rights`: `GET`/`POST` for the authorized review owner; `/consents/me` for each named signatory's own decision; `/review` for designated reviewers; `/display/me` for own audience-specific display; `/disputes` for bounded authorized claims. An invitation to review does not create app membership or grant source access. Review recipients get only the evidence necessary to decide their own consent, with explicit redaction for other participants. Notifications are not automatically sent by merely creating these records.

## Marketplace projection and UI

Signed-in listing viewers receive only the approved display projection: visible name/label, wording such as “Reviewed licensors”, reviewed version/date and plain-language explanation of the review's scope. Do not use an unqualified “verified legal owner” badge. No raw Git email/login, private user ID, contribution report, contracts, dispute details or collaborator roster is returned. Do not disclose a hidden person's existence or a full owner count through omitted-card placeholders.

No contributor percentage appears as an ownership share. If future design includes a visible activity metric, require separate metric-specific consent and a reviewed aggregate with its policy/period/completeness. Initial projection can omit metrics entirely while reviewers use them privately. Existing signed-in #541/#586 profile work can supply presentation primitives only after its audience and consent rules are reconciled. The anonymous consumer storefront remains independent, consistent with its later anonymity work.

Owner review UI has separate tabs for **Activity evidence**, **Rights and consent**, and **Listing preview**. Activity shows completeness, period, exclusions and optional weighting comparison. Rights shows required decisions and outstanding evidence without implying that large contributors must be owners. Preview shows exactly what a developer buyer will receive. Loading/partial/stale/revoked/error states never resemble zero contribution or completed consent. Keyboard access and small-screen layout apply to review dialogs and the listing cards.

## Proposed phased work packages

These are specifications for later issues, not instructions to file them now. Coordinate with marketplace M1–M6 and serialize migrations/shared authorization changes.

| Package | Dependencies and deliverable | Acceptance, tests and rollback |
| --- | --- | --- |
| R1 — reproducible private analysis prototype | Audit #544/#556/Console#13; extend existing ledger with completed-generation/report export and optional local read-only comparison. Begin with fully reconciled current head. | Exact head/policy/bounds; stable all-pages result; no extra ledger or grants. Fixtures cover every edge case above, current-head writes racing export, partial history, truncation, equal-rank ties, aliases, nonmember/revoked read, provider/local diff mismatch and deterministic digest. Disable export without disrupting existing stats; retain private reports according to approved retention. |
| R2 — reviewed authority and consent | R1 plus approved rights-review process and marketplace M1 immutable offer model. Add versioned private evidence, participants, own consents, disputes and scoped reviewer decisions. | LOC cannot mutate roles/owners; missing consent blocks approval; concurrent withdrawal/approval and transfer cannot activate stale terms. Real-D1 guarded-transition tests, first-party/session scope, evidence redaction, stale version and replay tests. Gate new reviews off; keep authorized audit and dispute access. |
| R3 — developer listing projection | R2 and marketplace listing API; reconcile #541/#586 audience rules. Minimal per-listing opted-in “Reviewed licensors” cards and review status. | Viewer receives no private facts; withdrawal/removed authority invalidates projection; source/profile edits cannot change accepted purchase terms. API field allowlist tests; Chromium/WebKit at 320/390px, account switching, cache/revocation, keyboard and partial/error states. Disable projection independently of private evidence. |
| R4 — sandbox integration acceptance | R1–R3 and marketplace M3–M6. Synthetic owner/team reviews pinned snapshot, purchase retains accepted consent version, buyer gets isolated copy. | Test missing/withdrawn consent, disputed title, source rewrite, transfer, payment/fulfilment race and privacy projection. Record exact revisions and test evidence; prove zero real rights/payment changes or public contributor release. Stop new sales/fulfilments on unresolved review; no destructive rollback of buyer work. |

Recency weighting is an optional analysis extension to R1 after plain totals reconcile. No package invents a combined code/promotion reputation score or reopens #381. Source, docs, Console and storefront work belong in their existing repositories, with backend contracts deployed before dependent clients.

## Design acceptance and limits

#692 is covered by the audited ledger/identity/API baseline, explicit historical and recency formulas, edge cases, reproducible read-only report design, private evidence versus reviewed rights, consent/dispute/version process, marketplace projection and phased test/rollback plan. No local-report command, new schema, legal entitlement, paid listing or source publication is implemented here. Live LOC completeness remains the responsibility of #544/#556 evidence for the chosen app; this design does not convert a closed ticket into a production observation.
