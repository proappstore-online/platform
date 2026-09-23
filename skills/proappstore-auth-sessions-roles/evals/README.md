# Evaluations

`cases.json` holds the scenarios #173 requires — a new app's sign-in, each
anti-pattern the skill must detect and remediate (session in storage,
`app.auth.token` coupling, home-grown sign-in or session tables,
membership-only gates, unsafe return URLs, incomplete sign-out, missing
negative tests), and a permissions screen — plus four blocker cases. Each
names the SDK surfaces, clauses, unsupported needs, rejected substitutes and
recipes a correct answer must contain. `test/skills-auth.evals.test.ts`
checks every expectation against the skill's reference files and the
published standard (`docs/standard/standard.json`), and guards against
fabricated APIs: every `app.<module>.<method>` the skill mentions must exist
in `packages/sdk/src`, every recipe must be one the `recipe` tool serves, and
every `sdk_reference` feature must be in the tool's enum.
