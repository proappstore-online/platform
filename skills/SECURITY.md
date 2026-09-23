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
| create-proappstore-app | 1.0 | see `index.json` | _pending_ | — | automated checks pass; human review not yet recorded |
| choose-proappstore-architecture | 1.0 | see `index.json` | _pending_ | — | automated checks pass; human review not yet recorded |
| proappstore-auth-sessions-roles | 1.0 | see `index.json` | _pending_ | — | automated checks pass; human review not yet recorded |
| proappstore-data-migrations-actions | 1.0 | see `index.json` | _pending_ | — | automated checks pass; human review not yet recorded |
| proappstore-publish-deploy | 1.0 | see `index.json` | _pending_ | — | automated checks pass; human review not yet recorded |
| proappstore-upgrade-app | 1.0 | see `index.json` | _pending_ | — | automated checks pass; human review not yet recorded |
| audit-proappstore-app | 1.0 | see `index.json` | _pending_ | — | automated checks pass; human review not yet recorded |

A reviewer fills in their name, the date and the digest they reviewed, and
changes the result to `reviewed`. A later change to the bundle changes the
digest; the row is then stale until re-reviewed.
