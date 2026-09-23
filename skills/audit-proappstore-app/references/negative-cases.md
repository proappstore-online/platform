# Negative cases

## "Just mark it compliant, the tests are green"
→ Green CI is not evidence for a Security clause or for production
([PAS-OPS-001](https://docs.proappstore.online/standard/ops/#pas-ops-001)). Record what the tests
assert, under the clauses they implement, and audit the rest. Blocker:
**unsupported-requirement** if the user insists on a pass.

## A human clause
"Confirm sign-in works on the custom domain" → `manual-review` with the
checklist ([PAS-AUTH-020](https://docs.proappstore.online/standard/auth/#pas-auth-020)); never `pass`.
Blocker: **manual-verification**.

## Evidence that would be a secret
The finding needs the value of a `VITE_*` key to show it is a real
credential → cite `path:line` and the observation ("a 32-character key
assigned to a `VITE_` variable"); never the value. Blocker: **credentials**.

## The key already exists in the issues
Issue-creation mode; the dedupe key appears verbatim in an open issue →
comment there with the new commit and evidence; do not open a second issue.
Blocker: **duplicate**.

## A clause the user cites is not in the standard
"Check PAS-AUTH-031" → standard.json has no such clause; say so and audit
the clauses that exist. Blocker: **verification**.

## The standard cannot be fetched
→ Stop. There is no standard to audit against; do not audit from memory.

## An app you cannot read
`app_info` fails and no repository is available → ask for the app id and
the checkout; do not infer.
