# Negative cases

## Third-party identity demanded
"Just use Firebase Auth, we already have it" → Do not design a hybrid. Cite
[PAS-STACK-006](https://docs.proappstore.online/standard/stack/#pas-stack-006) and give the platform
paths. Blocker: **unsupported-requirement**.

## A method that does not exist
"Call `app.auth.refresh()` before each request" → `sdk_reference` (feature
`auth`) shows no such method, and refresh is forbidden by
[PAS-AUTH-006](https://docs.proappstore.online/standard/auth/#pas-auth-006). Say so; the SDK handles
expiry. Blocker: **verification** if the user insists.

## Role vocabulary undecided
The user cannot say who may edit, moderate or administer → Do not invent one.
Propose `member` / `editor` / `moderator` and an admin role as a starting
set and ask. Blocker: **product-decision**.

## "Confirm sign-in works"
→ Only a person can, on the live app, on every hostname
([PAS-AUTH-020](https://docs.proappstore.online/standard/auth/#pas-auth-020)). Hand over the checklist.
Blocker: **manual-verification**.

## Team role used as an app permission
"Only team developers can delete posts" → Team roles say who may build the
app. Define an app role and gate the action with it
([PAS-AUTH-013](https://docs.proappstore.online/standard/auth/#pas-auth-013)); do not check the team role.

## An app you cannot read
`app_info` / `list_app_tools` fail or the app is not on ProAppStore → ask for
the repository or the app id; do not infer its auth.
