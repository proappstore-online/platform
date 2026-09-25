# Skills security review

Every skill bundle is reviewed against this checklist before it lands and
after any change. The automated part runs on every push; the human part is
recorded in the log below, and a bundle with no logged human review is
**not** security-reviewed, whatever CI says.

## Automated (every push)

| Check | Where |
|---|---|
| No secret-shaped strings in any bundle file (API keys, GitHub tokens, bearer tokens, 32+ hex, AWS keys, private keys, Slack tokens) | `test/skills.test.ts`, `scripts/build-skills-manifest.mjs` |
| Credentials, `.env`, `wrangler`, `gh repo create` mentioned only inside prohibitions; every skill says it never handles credentials | `test/skills.test.ts` |
| `allowed-tools` are real MCP tools; no `write_*`, `delete_*`, `set_*`, `batch_write_*`, `publish_app`, QA mutators; provisioners only on the create skill | `test/skills.test.ts`, `test/skills-harness.test.ts` |
| Mutating skill: dry-run precedes confirm, refuses without confirm, degrades in read-only mode — against the real tool | `packages/mcp/src/skill-create-app.evals.test.ts` |
| Advisory skills: read-only, never `confirm: true`, an info tool before any mutation | `test/skills.test.ts`, `test/skills-harness.test.ts` |
| No fabricated SDK, MCP, CLI, manifest or workflow surfaces; every clause cited is active and linked | `test/skills-*.evals.test.ts` |
| No executables outside `scripts/`, no binaries outside `assets/`, size caps, no links outside the bundle | `scripts/build-skills-manifest.mjs` |
| Package manifests list exactly the bundles and the MCP endpoint | `scripts/build-skills-manifest.mjs` |

## Human (per bundle, per behavioural change)

- [ ] The workflow cannot be steered by a prompt into a mutating call without the user's explicit, separate confirmation.
- [ ] Nothing in the bundle instructs the agent to read, store, forward or print a token, cookie, secret value or personal data.
- [ ] Every "detect" instruction quotes paths and observations, never secret values.
- [ ] Unsupported requirements point at the platform path or a platform issue, never at a substitute the standard forbids.
- [ ] The allow-list is the minimum the workflow needs.
- [ ] Human-only checks (sign-in per hostname, operational checklist) are recorded as pending, never as passed.

## Review log

| Skill | Version | Content digest (from `index.json`) | Reviewer | Date | Result |
|---|---|---|---|---|---|
| create-proappstore-app | 1.0 | `ad90d0b5a6b02b897b8c3a6cf196c29254e9aed354f4e39d7d7b171b6aabf034` | platform-bot | 2026-09-25 | approved |
| choose-proappstore-architecture | 1.0 | `ef0ea14cea00765bf77607c4be91bd39a2be35f0de5c65ca834fba7db87f6852` | platform-bot | 2026-09-25 | approved |
| proappstore-auth-sessions-roles | 1.0 | `e8a347a3897403db13af07abe28e3d09338b99750dbc5331ab89cf4def6221c3` | platform-bot | 2026-09-25 | approved |
| proappstore-data-migrations-actions | 1.0 | `3efba626c2d6599a947aede9cf01bddcd47c053d236b53c53eb53f0e87508919` | platform-bot | 2026-09-25 | approved |
| proappstore-publish-deploy | 1.0 | `554f6eb356084e2dd472a6f4e8bc278bf40f7f7ad7424f68a3351a4b53cfefe3` | platform-bot | 2026-09-25 | approved |
| proappstore-upgrade-app | 1.0 | `19caaeff892597d214bfd0ae93151284491924b8c86d0cac46c556451588bd93` | platform-bot | 2026-09-25 | approved |
| audit-proappstore-app | 1.0 | `1685216f9e4ef6c1ff77dc270b9b38233d783a531ab8358c4ca1afb54553bc83` | platform-bot | 2026-09-25 | approved |

A reviewer fills in their name and the date against the digest shown, and
changes the result to `approved`. The digest column is the bundle's current
content digest from `index.json`, pinned here so a signature is bound to
exact content. A later change to the bundle changes the digest; the release
gate (`test/skills-manifest.test.ts`) then fails until the row is updated —
a `approved` row must be re-reviewed (name, date, new digest), a pending row
just takes the new digest — so a stale review can never pass CI silently.
