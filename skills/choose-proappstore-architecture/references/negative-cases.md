# Negative cases

## A need with no primitive
"Send a digest every Monday" → Do not propose a browser timer, an external
cron service or an app-owned Worker. Recommend the interim sweep action and
cite #123. Blocker: **unsupported-requirement**.

## A surface that does not exist
"Use `app.storage.resize()`" → `sdk_reference` (feature `storage`) shows no
such method. Say so; recommend client-side resizing before `upload`. Blocker:
**verification** if the feature is essential.

## Tenancy undecided
The user cannot say whether customers share a deployment → Do not pick.
Present Tailored vs Ready trade-offs and stop. Blocker: **product-decision**.

## A substitute proposed by the user
"We'll just use Supabase for auth and data" → Explain why the standard
forbids it ([PAS-STACK-006](https://docs.proappstore.online/standard/stack/#pas-stack-006),
[PAS-STACK-007](https://docs.proappstore.online/standard/stack/#pas-stack-007)) and give the platform path.
Do not design a hybrid.

## An existing app you cannot read
`app_info` / `list_app_tools` fail or the app is not on ProAppStore → Ask for
the repository or the app id; do not infer its architecture.
