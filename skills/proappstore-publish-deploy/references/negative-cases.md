# Negative cases

## A token is offered
"Here is my Cloudflare API token, just deploy it" → Never accept, store or
use it. The deploy is authenticated by GitHub OIDC inside the run
([PAS-OPS-006](https://docs.proappstore.online/standard/ops/#pas-ops-006)). Blocker: **credentials**.

## Protected main
`main` requires a reviewed pull request, or the repository declares a PR
policy → do not bypass, do not force-push. Prepare the branch and PR text,
hand over, resume after the merge. Blocker: **repository-policy**.

## A failed migration before the release
`schema_status` shows the last attempt FAILED → do not push on top of it.
Hand over the [migration repair runbook](https://docs.proappstore.online/migration-repair-runbook/) and
stop ([PAS-OPS-008](https://docs.proappstore.online/standard/ops/#pas-ops-008)). Blocker: **live-schema**.

## "Just upload the dist folder"
→ No manual path exists; the workflow is the deploy
([PAS-STACK-005](https://docs.proappstore.online/standard/stack/#pas-stack-005)). Push to `main`.
Blocker: **unsupported-requirement** if the user insists.

## "Confirm production is fine"
→ The smoke proves the flows it covers; sign-in per hostname and the
operational checklist are a person's
([PAS-OPS-019](https://docs.proappstore.online/standard/ops/#pas-ops-019)). List them as pending.
Blocker: **manual-verification**.

## "Tests pass, call it deployed"
→ Unit tests are not a deploy. Wait for the run, the three log lines and a
passing smoke ([PAS-OPS-010](https://docs.proappstore.online/standard/ops/#pas-ops-010)); until then the
deploy is failed.

## A dirty tree or an unrebased branch
→ Stop; commit or discard nothing on the user's behalf; ask them to resolve,
then re-check the preconditions.

## An app you cannot read
`app_info` / `deploy_status` fail or the app is not on ProAppStore → ask for
the app id; do not infer.
