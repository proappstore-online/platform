# Negative cases

## "Just regenerate it from the template"
→ No; that overwrites product code. Show the ownership table and the staged
plan ([PAS-STACK-001](https://docs.proappstore.online/standard/stack/#pas-stack-001)). Blocker:
**unsupported-requirement** if the user insists on a wholesale rewrite.

## A stage would touch product code
The platform-cookie stage needs a line removed from `web/src/auth.ts` → show
the diff and stop; wait for the user's decision; do not bundle it with the
`initPro` change. Blocker: **review-required**.

## A stored token in the old workflow
`deploy.yml` uses a Cloudflare API token secret → never reuse it; replace the
workflow with the keyless canonical one and ask the user to delete the
secret ([PAS-OPS-006](https://docs.proappstore.online/standard/ops/#pas-ops-006)). Blocker:
**credentials**.

## A failed migration on the live app
`schema_status` reports FAILED → do not build the data-layer stage on it;
hand over the [migration repair runbook](https://docs.proappstore.online/migration-repair-runbook/)
([PAS-OPS-008](https://docs.proappstore.online/standard/ops/#pas-ops-008)). Blocker: **live-schema**.

## "Confirm sign-in still works after the cookie change"
→ Only a person can, on every hostname
([PAS-AUTH-020](https://docs.proappstore.online/standard/auth/#pas-auth-020)). List it as pending.
Blocker: **manual-verification**.

## A surface that does not exist
"Set `authMode: 'hybrid'`" → the SDK has `platform-cookie` and
`legacy-bearer` only (`sdk_reference`, feature `auth`). Say so. Blocker:
**verification** if the user insists.

## "Do all stages in one go"
→ Refuse the single commit; each stage is released and smoke-tested on its
own so a failure can be reverted alone
([PAS-OPS-009](https://docs.proappstore.online/standard/ops/#pas-ops-009)).

## An app you cannot read
`app_info` fails or the repository is not available → ask for the app id
and repository; do not infer its shape from the template.
