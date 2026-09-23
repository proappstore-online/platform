# Evaluations

`cases.json` holds end-to-end fixtures that drive the **real**
`provision_pas_app` MCP tool (with GitHub, ownership and backend mocked) and
assert on its text — the same output the skill instructs the agent to read.
They run in the platform test suite:
`packages/mcp/src/skill-create-app.evals.test.ts`.

Classes: `happy` (plan, success, provenance), `template` (catalogue
refusals), `confirm` (no confirm → no mutation), `rerun` (idempotent reuse),
`blocker` (one per class: credentials, ownership, template, compliance).
`test/skills.test.ts` checks that every blocker class in
`references/negative-cases.md` has at least one fixture.
