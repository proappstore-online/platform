# Negative cases — what a correct run looks like when it must stop

Each case names the signal, the required behaviour, and the blocker class for
the report. The machine-checked versions are in `../evals/cases.json`.

## Not signed in
`whoami` / `provision_pas_app` → `Error: authentication required…`
→ Stop. Deliver the gathered inputs and the intended plan as text. Blocker:
**credentials**. Never ask for a token.

## Read-only server
`provision_pas_app … confirm: true` → `MCP is in read-only mode (MCP_READ_ONLY);
provision_pas_app is a mutating tool and was blocked.`
→ The dry-run plan is the deliverable. Blocker: **credentials/operator**.

## Unknown template
`template_repo: "starter-v2"` → `Refused: unknown template "starter-v2".
Approved templates: template-app…` (also in dry-run)
→ Re-run with an approved id or omit it. Blocker if the user insists:
**template** (admin override only).

## Non-admin override
`allow_unapproved_template: true` without the `admin` role → `Refused … requires
a platform admin session.` → Blocker: **template**.

## Missing confirmation
Live call without `confirm: true` → `Refused: provision_pas_app creates/reuses …
Re-call with confirm: true to proceed.` → Ask the user; never add `confirm`
on your own.

## Repo owned by someone else
Repo exists, app record belongs to another account → `Error: <org>/<id> already
exists and its PAS app record is owned by another account.` → Blocker:
**ownership**.

## Repo exists with foreign commits, no record
`… has commits beyond the template scaffold …` → Blocker: **ownership**
(platform admin decision).

## Template repo not flagged as a GitHub template
`GitHub returned 404 from the template-generate API. The source template repo … must exist and be marked as a GitHub template.` →
Blocker: **template** (platform-side configuration).

## Compliance failure at provision
`/v1/provision` 412; result says `PAS app provisioning finished with issues`
with a `compliance` step naming the rule → Blocker: **compliance**; report the
rule and clause URL; re-run after the fix.

## Template revision unresolved
`~ Template revision: could not resolve …` → Not a blocker; report the
revision as unknown. Never fill it in from the catalogue's reviewed commit.
