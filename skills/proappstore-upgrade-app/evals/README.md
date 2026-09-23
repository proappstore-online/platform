# Evaluations

`cases.json` holds the scenarios #177 requires — a dry-run report on an old
app with customised code, one bounded stage each for toolchain and SDK,
workflows, the platform-cookie migration, the data layer and the UI/PWA
baseline, the refusal to rewrite a customised app, and a stage rollback —
plus six blocker cases (unsupported requirement, review required,
credentials, live schema, manual verification, verification). Each names
the MCP tools, baseline values, workflow steps, log lines, compliance check
ids, SDK surfaces, clauses, unsupported needs and preserved files a correct
run must contain. `test/skills-upgrade.evals.test.ts` checks every
expectation against the skill's reference files, the template catalogue
(`packages/build-core/src/template-catalogue.ts`), the canonical deploy
workflow, the compliance check map, the SDK source and the published
standard, and guards the security properties: read-only allow-list, no
credentials handled, dry-run by default, one stage per commit, product-owned
files never overwritten, explicit review before destructive or broad
changes, and human checks kept pending.
