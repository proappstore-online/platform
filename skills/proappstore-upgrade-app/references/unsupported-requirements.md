# Unsupported requirements — say so, give the interim pattern, cite the clause

A requirement here has **no platform primitive today**, or is forbidden by
the standard. Recommend the interim pattern; never a rewrite or a manual
workaround.

| Requirement | Status | Interim pattern that conforms | Cite |
|---|---|---|---|
| Automatic "re-scaffold" that regenerates the app from the template | not offered — and it would overwrite product code | the staged plan: re-sync template-owned files, minimal reviewed diffs elsewhere | [PAS-STACK-001](https://docs.proappstore.online/standard/stack/#pas-stack-001) |
| Moving the app to a template that is withdrawn or not in the catalogue | rejected by the catalogue | stay on the approved template; adopt its baseline stage by stage | [PAS-STACK-001](https://docs.proappstore.online/standard/stack/#pas-stack-001) |
| Keeping `legacy-bearer` on a hosted app "for now" | compatibility default, not a supported state | stage 4 with custom domains registered first; a person verifies sign-in | [PAS-AUTH-001](https://docs.proappstore.online/standard/auth/#pas-auth-001) |
| A schema "cleanup" that drops or renames columns during the upgrade | forbidden — schema is forward-only | additive migrations; expand / contract; reverted code tolerates old columns | [PAS-DATA-002](https://docs.proappstore.online/standard/data/#pas-data-002), [PAS-OPS-008](https://docs.proappstore.online/standard/ops/#pas-ops-008) |
| Reconstructing `migrations.json` by editing history to match the live schema | never re-applies | one initial entry per already-applied statement, in order, then additive entries; verify with `schema_status` | [PAS-DATA-002](https://docs.proappstore.online/standard/data/#pas-data-002) |
| Keeping a stored Cloudflare or R2 token because the old workflow used it | forbidden | the canonical keyless workflow; the user deletes the secret | [PAS-OPS-006](https://docs.proappstore.online/standard/ops/#pas-ops-006) |
| Upgrading in a single commit with no per-stage release | not supported by the rollback model | one stage per commit, each released and smoke-tested | [PAS-OPS-009](https://docs.proappstore.online/standard/ops/#pas-ops-009), [PAS-OPS-010](https://docs.proappstore.online/standard/ops/#pas-ops-010) |
| A preview environment to test the upgraded app before `main` | not offered | local development with the same SDK; small stages; fast revert | [PAS-OPS-009](https://docs.proappstore.online/standard/ops/#pas-ops-009) |
| An SDK major version or a surface that `sdk_reference` does not show | does not exist | stay on the published 1.x surface; say the surface is absent | [PAS-STACK-002](https://docs.proappstore.online/standard/stack/#pas-stack-002) |
| Automated proof that sign-in works after the cookie migration | not offered — a human check on every hostname | a person's checklist, recorded with date and operator | [PAS-AUTH-020](https://docs.proappstore.online/standard/auth/#pas-auth-020) |
| Replacing the design tokens or fonts with the customer's brand during the upgrade | forbidden on the store | keep the canonical tokens; the accent stays the platform's | [PAS-UI-001](https://docs.proappstore.online/standard/ui/#pas-ui-001) |

When a gap is decisive, say so and stop: it is a **blocker: unsupported
requirement**, not a reason to rewrite around the standard.
