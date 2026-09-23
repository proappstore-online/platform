# Evaluations

`cases.json` holds the scenarios #175 requires — a new schema with its
actions, a multi-tenant scope, and one remediation each for cross-tenant
access, guessed identifiers, replayable grants, unsafe writes, migration or
action drift, raw browser SQL, client-only authorization and injection —
plus five blocker cases. Each names the SDK surfaces, manifest keys, magic
parameters, clauses, unsupported needs, rejected substitutes and recipes a
correct answer must contain. `test/skills-data.evals.test.ts` checks every
expectation against the skill's reference files and the published standard
(`docs/standard/standard.json`), and guards against fabricated APIs: every
`app.<module>.<method>` must exist in `packages/sdk/src`, every manifest key
must be one the platform's manifest validator understands, every magic
parameter one the executor injects, every recipe one the `recipe` tool
serves, and every `sdk_reference` feature one in the tool's enum.
