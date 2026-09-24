# Approved templates

The catalogue of templates a ProAppStore app may be provisioned from, and the
selection contract every provisioning path applies. Machine-readable copy:
[`templates/catalogue.json`](./catalogue.json) (schema:
[`catalogue.schema.json`](./catalogue.schema.json)); the MCP tool
`list_templates` returns the same data.

There is one approved template today. The catalogue exists so that template
selection is governed — identity, purpose, compatibility, security status,
maintainer, reviewed revision, deprecation — not so that it is long. Entries are
added only for reviewed, maintained templates (see
[#179](https://github.com/proappstore-online/platform/issues/179) and
[#180](https://github.com/proappstore-online/platform/issues/180) for the
candidates under investigation).

## Selection contract

| You name… | Provisioning does |
|---|---|
| nothing | uses the **default** (`template-app`) |
| an **approved** id | proceeds |
| a **deprecated** id | proceeds and records a warning naming the replacement |
| an **unknown** or **withdrawn** id | **refuses** (400 from `/v1/provision`; `Refused:` from `provision_pas_app`; an error from `pas create`) and lists the approved ids. A platform admin may pass an explicit override, which is recorded on the app |

Every path — `pas create` → `pas publish`, the MCP `provision_pas_app` and
`scaffold_app` tools, and `POST /v1/provision` — records **which template and
which exact source commit** was copied on the app row (`apps.template_id`,
`apps.template_rev`, returned by `GET /v1/apps` and the `app_info` tool). The
revision is the template repository's branch head at the moment of the copy;
if it cannot be resolved it is recorded as unknown, never guessed. The
catalogue's `release.source_commit` is the *reviewed* revision; the app's
`template_rev` is the *copied* one — normally equal, and the difference is
exactly what an audit wants to see.

## How the create-app workflow uses it

1. Read [`catalogue.json`](./catalogue.json) (or call `list_templates`).
2. Pick the approved template whose `supported_categories` and `capabilities`
   fit; explain the choice; default to `template-app`.
3. Call `provision_pas_app` with `template_repo: <id>` and `dry_run: true`, then
   with `confirm: true`. Unknown ids are refused before any repository or
   infrastructure is created.
4. Check the result's `Template revision:` line and, later,
   `app_info` → `template_id` / `template_rev`.
5. Apply the template's `security_compliance.known_deviations` on day one —
   they are the Application Standard clauses the scaffold does not yet meet.

## Catalogue

| id | repo@ref | status | reviewed commit | categories | requires | known deviations |
|---|---|---|---|---|---|---|
| `template-app` (default) | `proappstore-online/template-app@main` | approved | `d8c2e08f32b8` (2026.09.23) | any | sdk >=1.16.0, cli >=2.6.0, node >=22, pnpm 10.x | [PAS-AUTH-001](../standard/auth.md#pas-auth-001), [PAS-UI-002](../standard/ui.md#pas-ui-002), [PAS-UI-007](../standard/ui.md#pas-ui-007) |

### `template-app` — ProAppStore app template

The canonical Pro app scaffold: React 19 + Vite 8 + Tailwind 4 web/ workspace, @proappstore/sdk, registered actions (mcp.json), additive D1 migrations (migrations.json), PWA manifest and service worker, the keyless deploy / CI / compliance workflows, and the design tokens. Suits any app category.

- **Capabilities:** platform-auth, registered-actions, d1-migrations, pwa, design-tokens, keyless-oidc-deploy, ci-typecheck, compliance-workflow, app-shell
- **Security / compliance:** reviewed on 2026-09-23. Template actions list_items/get_item are scoped to the calling user (d8c2e08). Known deviations an app must fix on day one: initPro() is called without authMode (PAS-AUTH-001), the theme boot script reads fas:theme instead of stores-theme (PAS-UI-002), and the viewport meta ships user-scalable=no (PAS-UI-007). Tracked for the template repository.
- **Maintainer:** proappstore-online — https://github.com/proappstore-online/platform/issues
- **Preview:** https://docs.proappstore.online/getting-started/
- **Deprecation:** none

## Candidate archetypes

The 2026-09-23 investigation of the org's app repositories (#179) found three
recurring domain spines and recommends one template for each — membership
groups, back-office records workspace, two-sided listings marketplace — with
an implementation ticket per archetype (#189, #190, #191). Evidence matrix,
scores, what to extract and what must not be copied:
[Template archetypes](./archetypes.md). None is in the catalogue until it
exists as a reviewed template repository.

The marketplace template (#191) is built and staged in this repository at
`templates/template-marketplace/` — manifest, migrations, UI and negative tests — and
validated by `test/template-marketplace.test.ts` against the platform's own registration
and migration rules. It enters the catalogue once it is published as the GitHub template
repository `proappstore-online/template-marketplace` (an org-owner action, since
repository creation is disabled for members) and its reviewed commit is recorded.

## Adding, deprecating, withdrawing

A template enters the catalogue only after it exists as a GitHub template
repository in `proappstore-online`, passes `pas check`, has been audited
against the [Application Standard](../standard/index.md) with its deviations
listed, and has a maintainer. Deprecation keeps the entry (status
`deprecated`, with `replaced_by` and a reason) so existing apps' provenance
still resolves; withdrawal keeps the entry too and makes provisioning refuse
it. Entries are never deleted or renamed — `template_id` on existing apps must
always resolve. The source of truth is
`packages/build-core/src/template-catalogue.ts`; `catalogue.json` is generated
from it and a test fails on drift.
