# Port from Firebase

Maps each Firebase piece an app used to today's ProAppStore primitive. Use it
alongside the [decision tables](decision-tables.md) and
[unsupported requirements](unsupported-requirements.md) — nothing here adds a
primitive the rest of this skill does not already name (platform#517).

## Mapping

| Firebase | ProAppStore | Notes |
|---|---|---|
| `firestore.rules` | registered actions with authz **in the SQL** (`:__user_id`, `auth.app_roles`), deny by default, one test per rule | There is no rule DSL: the `WHERE` clause is the only check a caller who calls the action directly meets. `auth.caller_unscoped` only with a real, specific reason — reviewed scoping, not a rules-migration shortcut ([PAS-DATA-012](https://docs.proappstore.online/standard/data/#pas-data-012), [PAS-AUTH-016](https://docs.proappstore.online/standard/auth/#pas-auth-016)) |
| Firestore collections / subcollections | D1 tables via registered actions, flattened with the parent's id as a foreign-key column; a nested or variable-shape document becomes a `TEXT` column holding JSON | [PAS-STACK-007](https://docs.proappstore.online/standard/stack/#pas-stack-007), [PAS-DATA-002](https://docs.proappstore.online/standard/data/#pas-data-002) |
| `onSnapshot` listeners | **`app.rooms`**, with an app worker broadcasting on write (#351) — never a poll loop; DoorDrop's polling burned its daily request quota (doordrop#64) | [PAS-STACK-013](https://docs.proappstore.online/standard/stack/#pas-stack-013) |
| Cloud Storage | **`app.storage`** | [PAS-STACK-012](https://docs.proappstore.online/standard/stack/#pas-stack-012) |
| Cloud Functions / callables | a registered **action** first; an app worker only for what SQL genuinely cannot express | [PAS-DATA-014](https://docs.proappstore.online/standard/data/#pas-data-014) |
| Firebase Auth | **`app.auth`** in platform-cookie mode; add `/.pas/*` to the PWA's offline denylist so the service worker never serves the app shell for a platform session route (doordrop#14) | [PAS-STACK-006](https://docs.proappstore.online/standard/stack/#pas-stack-006), [PAS-UI-018](https://docs.proappstore.online/standard/ui/#pas-ui-018) |
| Existing production data | the owner import path (the companion issue to this one) | — |
| Firebase Hosting | `pas create` plus the generated deploy workflow, with a QA flow run on every deploy | [PAS-OPS-012](https://docs.proappstore.online/standard/ops/#pas-ops-012) |

## Lessons from DoorDrop

DoorDrop was the first Firebase port, and its scoping gaps were closed one
issue at a time after the port shipped instead of up front (doordrop#28, #35,
#41, #43, #85, #87). Carry these into the next one:

- **Port in slices**, each verified live with a QA flow before starting the next.
- **Keep the port faithful.** A redesign is a separate issue, not something to
  fold into the port.
- **Plan the cutover and the Firebase project's retirement** on a date, not
  "eventually" — the old and new backends should not both stay live
  indefinitely.

## Superseded plans

This reference replaces `docs/doordrop-port-plan.md` and
`docs/grasskarma-port-plan.md`. Both predate registered actions and app
workers and disagreed with each other about the architecture; this table is
the current answer.
