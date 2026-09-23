# Negative cases

## Logic that is not SQL
"Validate the chess move on the server before saving" → no app-code
execution surface exists. Record the move as a claim and confirm it through
a privileged action ([PAS-DATA-014](https://docs.proappstore.online/standard/data/#pas-data-014)); cite
#148. Blocker: **unsupported-requirement**.

## A manifest key that does not exist
"Set `auth.row_policy` so the platform filters rows for me" → no such key;
the scoping predicate in the SQL is the row policy
([PAS-DATA-007](https://docs.proappstore.online/standard/data/#pas-data-007)). Say so. Blocker:
**verification** if the user insists on a platform-side policy.

## A method that does not exist
"Use `app.actions.transaction()`" → `sdk_reference` (feature `db`) shows
`app.actions.call` and `callPublic` only; atomicity is `operation: "batch"`
([PAS-DATA-009](https://docs.proappstore.online/standard/data/#pas-data-009)). Blocker: **verification**.

## Tenancy undecided
The user cannot say whether a coach sees one club or every club → do not
invent a scoping rule. Present self-scoping vs membership scoping and stop.
Blocker: **product-decision**.

## The live schema is broken
`schema_status` reports the latest migration FAILED → do not design on top
of it; hand over the [migration repair runbook](https://docs.proappstore.online/migration-repair-runbook/)
and stop. Blocker: **live-schema**.

## A raw-SQL shortcut proposed
"Just call `app.db.query` from the page, it's faster" → end users get 403
from the data worker, and the boundary would be the browser
([PAS-DATA-003](https://docs.proappstore.online/standard/data/#pas-data-003)). Give the registered action.

## An app you cannot read
`app_info` / `discover_tools` / `schema_status` fail or the app is not on
ProAppStore → ask for the repository or the app id; do not infer.
