# Evaluations

`cases.json` holds the scenarios #174 requires — a successful release, a
compliance failure, a deploy failure, a migration failure, stale assets and
a rollback — plus five blocker cases (credentials, repository policy, live
schema, unsupported requirement, manual verification). Each names the MCP
tools, deploy log lines, clauses, unsupported needs and rejected practices a
correct run must contain. `test/skills-publish-deploy.evals.test.ts` checks
every expectation against the skill's reference files, the published
standard (`docs/standard/standard.json`), the MCP server's registered tools,
the canonical deploy workflow (`packages/admin/src/__fixtures__/canonical-deploy.yml`)
and the CLI's commands, and guards the security properties: no credentials
handled, no manual infrastructure path, no success claimed from unit tests,
rollback only by revert, migrations never edited, and the evidence bundle
always required.
