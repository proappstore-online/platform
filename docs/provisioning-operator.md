# Provisioning operator

Standing up a new PAS app has two halves: **writing its code** and **operating the
platform**. The first half creates the repo and provisions its route, D1 database and
data worker. The second half verifies that it is live. They are different jobs with
different blast radii, so PAS keeps them apart (#132):

| | Repo Coder / Agent Teams | Provisioning operator |
|---|---|---|
| Job | Change an app's source code | Create and provision an app on the platform |
| Acts through | Git and the file tools | The ProAppStore MCP server's provisioning tools |
| Touches | One repository | Production infrastructure: a GitHub repo, a route, a D1 database, a data worker |
| Identity | Its own repo instance | The app **owner's** authenticated MCP session |

Agent Teams deliberately cannot provision. Its runner strips `scaffold_app`,
`provision_app` and `get_deploy_status` from every role, and deployment is a
deterministic system stage after QA, not an agent action.

## The operator is a skill, not a new agent

The operator is not a separate agent template. It is any MCP client connected to
`https://mcp.proappstore.online/mcp` **as the app's owner**, following the
[`create-proappstore-app` skill](./skills/index.md). That skill is the operator
playbook:

1. `whoami` to confirm who will own the app.
2. Gather the app id, name, description and data needs, then `list_templates` and
   pick an approved template, explaining the choice.
3. `provision_pas_app` with `dry_run: true`, and show the user the plan.
4. Get an explicit yes, then `provision_pas_app` with `confirm: true`.
5. Verify: the repo, R2 route, D1 database, data worker, deploy configuration,
   registered actions and live status (`app_info`, `deploy_status`, `schema_status`,
   `list_app_tools`).

`provision_pas_app` does the whole operator workflow in one idempotent call:

- creates or reuses the repo from an approved template (private by default);
- sets the deploy variables;
- replaces the template's `APPNAME` placeholders in every file and checks that none
  remain;
- records the copied template revision;
- calls `POST /v1/provision`;
- verifies the result.

It reports every step it created, skipped or failed. Publishing to the storefront is a
separate, deliberate step (`publish_app`).

## Least privilege

- **The owner's own session, nothing pasted.** The operator acts as the app owner
  over OAuth (or the owner's PAS session). It never handles a copied token.
  `scripts/provision-all.sh` needed a pasted `FAS_SESSION_TOKEN` and is kept only as
  a marked legacy file.
- **No infrastructure credentials in the agent.** The GitHub org token and the
  Cloudflare and R2 credentials live in Worker secrets (the MCP Worker and the
  backend). The model sees tool results, never keys.
- **Dry run, then confirm.** Every tool that creates or changes infrastructure
  previews with `dry_run: true` and refuses a live run without `confirm: true`:
  `provision_pas_app`, `scaffold_app`, `provision_app`, `publish_app` and
  `delete_file`. A preview needs no confirmation and works even in read-only mode.
  An operator must show the plan and get a human yes before it passes
  `confirm: true`, and it must ask again before a **retry** that changes a live app.
- **Ownership.** `provision_app` (re-provisioning an existing app) and the other
  project tools call `requireOwner`, so a session can only operate apps it owns.
  `POST /v1/provision` refuses to re-provision an app claimed by someone else,
  except for platform admins. It applies per-user and per-IP rate limits, accepts
  only approved templates, and runs compliance unless an admin bypasses it.
- **Audited, and read-only on request.** Every mutating call, dry run and read-only
  denial is written to the caller's 90-day MCP audit trail (`mcp_audit_log`).
  `MCP_READ_ONLY=1` blocks every mutation server-wide.
- **No teardown.** Deprovisioning is out of scope. Deleting an app's dashboard
  record leaves its infrastructure, repo and listing alive, so treat every
  provision as permanent.

## Tools involved

| Tool | Role | Gate |
|---|---|---|
| `whoami` | Confirm the acting identity | — |
| `list_templates` | The approved-template catalogue | — |
| `provision_pas_app` | Create and provision a new app, and verify it | `dry_run`, `confirm` |
| `provision_app` | Re-provision an existing app you own (idempotent) | owner, `dry_run`, `confirm` |
| `list_apps`, `app_info` | What you own; one app's URLs, repo and status | — |
| `deploy_status`, `get_deploy_status` | GitHub Actions deploy state | — |
| `schema_status` | D1 migration state (owner) | — |
| `list_app_tools` | The app's registered actions | — |
| `publish_app` | List the app on the storefront (separate decision) | owner, `dry_run`, `confirm` |
| `mcp_audit_log` | The operator's own audit trail | — |

See [MCP: App Tools](./mcp-app-tools.md) for the app-side surface and
[Publishing Flow](./publishing-flow.md) for what happens after provisioning.

## Phases

The investigation on #132 set out four phases. Only the first is built. The rest
wait on owner decisions and will be filed as their own issues once decided.

1. **Now (built).** An owner-approved `provision_pas_app` run for one app from an
   approved template, private repo, dry run then confirm, with built-in verification.
   It needs no service credential, no new agent template, no public publish and no
   teardown. `provision_app` has the same confirm gate, so a re-provision is also
   approved explicitly.
2. **Only if unattended operation is approved.** A new, revocable
   provisioning-operation credential, never a copied human session or the shared
   internal token.
   - **Bound to:** one owner, one approved request id or digest, one app id, an
     approved template and revision, and a short expiry.
   - **Allowed:** create from template, set deploy variables, provision, read status.
   - **Excluded:** generic GitHub or Cloudflare access, compliance bypass, template
     override, publishing, cross-owner re-provision, and all deletion.
   - It needs a durable `provision_requests` record for approval, retry and audit.
   - **Owner decisions pending:** who issues and rotates it, and what counts as
     approval for a retry.
3. **Then.** A persistent readiness and status view built from the existing step
   output, Actions state, host and schema checks. Retries are still approved
   separately.
4. **Later.** An optional hand-off that registers the new repo with a fresh Repo
   Coder instance, once its control plane is chosen. A failed hand-off must never
   invalidate the provisioned app.

## Sources of truth

`scripts/provision-all.sh` is **not** a source of app definitions. Use instead:

- the [approved-template catalogue](./templates/index.md) for what an app starts from;
- the app's GitHub repo for its code and configuration;
- the platform `apps` table (`GET /v1/apps`) for ownership and provenance;
- `app_listings` for deliberately authored storefront data.
