# Evaluations

`cases.json` holds the five scenarios #171 requires — simple CRUD,
multi-tenant, realtime collaboration, file-heavy, background work — each with
the primitives, clauses, unsupported needs, rejected substitutes and recipes a
correct decision must contain. `test/skills-architecture.evals.test.ts`
checks every expectation against the skill's own reference files and against
the published standard (`docs/standard/standard.json`), and additionally
guards against fabricated APIs: every `app.<module>` the skill mentions must
be a real module of `@proappstore/sdk`, every recipe a documented one, and
every `sdk_reference` feature one the tool accepts.
