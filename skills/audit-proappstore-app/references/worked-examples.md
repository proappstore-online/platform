# Worked examples

One per evaluation scenario. The findings shown are the ones in
`evals/fixtures/`, which validate against the published finding contract.

## legacy-token-storage — session kept in localStorage on a hosted app

Fixture: `evals/fixtures/legacy-token-storage.json`. Direct rules 1 and 2
hit: `web/src/lib/app.ts:3` calls `initPro({ appId: 'tasks-demo' })` with
no authMode, and `web/src/lib/session.ts:4` reads
`localStorage.getItem('pas:session')`. Hosted (deploy.yml uploads to
`apps/tasks-demo/`), so the clauses apply. Findings: `fail` for
[PAS-AUTH-001](https://docs.proappstore.online/standard/auth/#pas-auth-001) (high, confidence high) and
[PAS-AUTH-002](https://docs.proappstore.online/standard/auth/#pas-auth-002) (critical, confidence high);
remediation bounded to `authMode: 'platform-cookie'` and deleting the
storage code; acceptance tests from the clauses; dedupe keys
`tasks-demo:PAS-AUTH-001:web/src/lib/app.ts` and
`tasks-demo:PAS-AUTH-002:web/src/lib/session.ts`. Unsupported: none.

## missing-tenant-guard — an authenticated action scoped by id only

Fixture: `evals/fixtures/missing-tenant-guard.json`. Direct rule 8 hits:
`mcp.json` tool `update_item` has `requires_auth: true` and the statement
`UPDATE items SET done = :done WHERE id = :id` — no `:__user_id`, no
membership sub-query. Ready app (an `org_members` table exists), so
[PAS-DATA-007](https://docs.proappstore.online/standard/data/#pas-data-007) applies; also fails
[PAS-STACK-011](https://docs.proappstore.online/standard/stack/#pas-stack-011). Finding: `fail`,
critical, confidence high; remediation: `AND org_id IN (SELECT org_id FROM
org_members WHERE user_id = :__user_id)`; acceptance test: as user B with
A's id → `meta.changes === 0`; dedupe key
`ledger:PAS-DATA-007:mcp.json`. Unsupported: none.

## conforming-app — no direct-rule hits

Fixture: `evals/fixtures/conforming-app.json`. `initPro` passes
`authMode: 'platform-cookie'`; no storage or token code; every
`requires_auth: true` statement scopes on `:__user_id`; the viewport meta
allows zoom; no HTML sinks. The direct rules produce no finding; the
clauses they cover are recorded `pass` with the evidence paths. The rest of
the chapters are still walked ([PAS-AUTH-001](https://docs.proappstore.online/standard/auth/#pas-auth-001),
[PAS-AUTH-002](https://docs.proappstore.online/standard/auth/#pas-auth-002), [PAS-DATA-007](https://docs.proappstore.online/standard/data/#pas-data-007),
[PAS-UI-007](https://docs.proappstore.online/standard/ui/#pas-ui-007) pass; [PAS-DATA-003](https://docs.proappstore.online/standard/data/#pas-data-003)
pass). Unsupported: none.

## tailored-not-applicable — a Ready-only clause on a Tailored app

The app has no membership tables and one customer per fork.
[PAS-STACK-011](https://docs.proappstore.online/standard/stack/#pas-stack-011) is recorded
`not-applicable` with the evidence: "Tailored — `migrations.json` defines
no membership or tenant table; README states one deployment per customer".
Never skipped. Unsupported: none.

## human-only-clause — sign-in on the live app

[PAS-AUTH-020](https://docs.proappstore.online/standard/auth/#pas-auth-020) and
[PAS-OPS-019](https://docs.proappstore.online/standard/ops/#pas-ops-019) are recorded `manual-review`
with the checklist for a person, `human_validation: required`, even though
the smoke run passed. Unsupported: marking them pass (interim: a person
records the result).

## issue-creation-mode — opening issues after the duplicate check

The user asks for issues at severity high and above. For each such finding
the repository's issues are searched for the dedupe key; one key is found
in an open issue, which receives a comment with the new commit and
evidence; the other findings become issues titled by the defect
("Session kept in localStorage: initPro runs in legacy-bearer mode on a
hosted app" for [PAS-AUTH-001](https://docs.proappstore.online/standard/auth/#pas-auth-001)), in the published body shape, each carrying the key verbatim.
Read-only mode would have produced only the report. Unsupported: none.
