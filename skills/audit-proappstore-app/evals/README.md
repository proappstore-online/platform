# Evaluations

`fixtures/` holds three deterministic repository fixtures — a legacy session
kept in browser storage, an authenticated action with no SQL tenant guard,
and a conforming app — each with the files an auditor reads and the exact
findings the audit must produce. `cases.json` holds the scenarios #172
requires (the three fixtures, a not-applicable tenancy clause, a human-only
clause, issue-creation mode) plus five blockers. `triggers.json` and
`contract.json` follow the shared harness contract.

`test/skills-audit.evals.test.ts` applies the skill's direct rules
(`references/direct-rules.md`) to every fixture and asserts the expected
fail set; validates every expected finding, and the assembled report, against
the published finding contract (`docs/standard/finding.schema.json`); checks
each finding's clause URL, severity and verification class against
`standard.json` and its deduplication key against the published formula; and
checks the skill's rules — fetched standard, one result per clause, human
clauses never passed, read-only default, duplicate check before issues —
are present. Idempotency is proved by running the rules twice and comparing.
