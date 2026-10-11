# Provisioning API: preview and confirmation

The Creator Console creates a PAS app, reuses an app it owns, or adopts an
untouched scaffold through two calls: a **preview** that changes nothing, and an
explicit **confirmation** of exactly that preview (#367). The Console UI is #368.

This is the `provision_pas_app` workflow, the same one the MCP tool runs. It is
not a second hosting backend, and it is not the storefront review flow
(`/v1/submissions`). The browser uses the PAS session it already holds; no other
login, grant or credential is involved. The org GitHub credential stays on the
platform's MCP worker, which the API reaches over a service binding.

## Rules the routes enforce

- **Normal compliance always runs.** There is no `skipCompliance` and no
  unapproved-template override on this path.
- **Only approved templates** from the [catalogue](./templates/catalogue.json),
  named explicitly by id.
- **One repository:** `repoUrl` must be exactly
  `https://github.com/proappstore-online/<appId>`. No other repository is
  inferred or used.
- **Who may do what is unchanged:**
  - **Create:** the repository does not exist yet.
  - **Reuse:** you own the PAS app, or you are a platform admin.
  - **Adopt:** the repository has no PAS app record and is still the untouched
    template scaffold (its only commit is the template copy).
  - **Refused:** someone else's app, an edited orphan, or anything that cannot
    be checked.
- **The revision is proven, or recorded as unknown.**
  - **New repository:** the template head read just before the copy, and only
    once the new repository's initial tree is verified to be that commit's tree
    (#369).
  - **Existing scaffold:** the template commit whose tree equals the scaffold's
    first commit.
  - An existing repository is never credited with today's template head.
  - Adoption requires that proof.
  - A `templateRev` you send is either proven and honoured, or the plan is
    blocked. It is never ignored.
- **Visibility:** an existing repository's visibility is reported, never
  changed. A new repository is created private.

## 1. Preview

`POST /v1/provisioning/plans` with `Authorization: Bearer <PAS session>`

```json
{
  "appId": "school-clubs",
  "name": "School Clubs",
  "description": "Coordinate school clubs.",
  "template": "template-marketplace",
  "repoUrl": "https://github.com/proappstore-online/school-clubs",
  "templateRev": "4b000c9"
}
```

`templateRev` is optional, 7–40 hex characters. `name` is up to 80 characters and
`description` up to 300.

**What it does:** reads GitHub and the platform, then stores the plan bound to
you. It creates, changes or reserves nothing: no repository, app record,
infrastructure, receipt, quota or access. A plan with blockers is still stored
and returned, so it can be shown.

**`201`:**

```json
{
  "planId": "5b0c…",
  "expiresAt": 1791700000000,
  "plan": {
    "version": 1,
    "appId": "school-clubs",
    "name": "School Clubs",
    "description": "Coordinate school clubs.",
    "action": "create",
    "repository": {
      "owner": "proappstore-online", "name": "school-clubs",
      "url": "https://github.com/proappstore-online/school-clubs",
      "exists": false, "private": true
    },
    "appRecord": "none",
    "template": {
      "id": "template-marketplace", "repo": "proappstore-online/template-marketplace", "ref": "main",
      "status": "approved", "reviewedCommit": "4b000c99…", "requestedRevision": "4b000c9",
      "revision": "4b000c99…", "revisionSource": "template_head"
    },
    "changes": ["create private GitHub repository …", "…"],
    "compliance": { "required": true },
    "blockers": [],
    "warnings": []
  }
}
```

### Plan fields

| Field | Values |
|---|---|
| `action` | `create`, `reuse_owned`, `reuse_admin`, `adopt_untouched`, `refused` |
| `repository` | `exists` is `true`, `false`, or `null` when GitHub could not be read. `private`, `headSha` and `untouchedScaffold` appear only when you may act on the repository. For someone else's or an edited repository, nothing beyond its existence is shown. |
| `appRecord` | `none`, `owner`, `other`, `unknown` |
| `template.revisionSource` | `template_head` (a new copy), `scaffold_tree_match` (proven for an existing scaffold), `unknown` |
| `blockers[].code` | `repository_unavailable`, `owned_by_another_account`, `app_record_unavailable`, `repository_edited`, `revision_unresolved`, `revision_not_current`, `revision_mismatch`, `revision_unverified` |
| `warnings` | Non-blocking notices: a deprecated template, or a template head that differs from the reviewed commit |

A plan with any blocker cannot be confirmed. The plan expires 10 minutes after
the preview.

### Preview errors

- **`400`:** invalid id, missing field, a `repoUrl` that is not the app's own
  repository, a malformed `templateRev`, or an unknown or withdrawn template.
- **`401`:** not signed in.
- **`502` or `503`:** the workflow is unavailable. Retry the preview.

## 2. Confirm

`POST /v1/provisioning/plans/{planId}/confirm` with the same session and an
empty JSON body.

**What it does:**
1. Re-plans with the stored input and compares every bound fact: action,
   repository existence, visibility and head, app-record state, template id,
   requested revision, revision and its source, compliance, and blocker codes.
2. If anything differs, nothing runs.
3. Otherwise it takes the app's durable provisioning receipt (#358) and runs
   the workflow:
   1. copy or reuse the repository;
   2. commit the `APPNAME` replacements;
   3. call `/v1/provision`: compliance, then the route, D1, data worker and app
      record;
   4. verify the repository, deploy and host.

| Status | Body | Meaning |
|---|---|---|
| `200` | `{ planId, receipt, appId, status, steps, result?, joined, repoAction?, succeeded?, error?, log? }` | Executed under `receipt`, or joined a receipt that is already running or complete (`joined: true`). `status` is `pending`, `completed`, `failed` or `exhausted`. `succeeded: false` with `status: "failed"` is an honest partial failure, such as a compliance refusal. Its `steps` carry the evidence. |
| `202` | `{ planId, joined: true, status: "pending", receipt \| null, … }` | Another confirmation of this plan is executing. Poll progress. `receipt` may be `null` for a moment while that confirmation acquires it. |
| `404` | `{ error: "plan_not_found" }` | No such plan, or not yours |
| `409` | `{ error: "plan_changed", plan }` | Something changed since the preview. `plan` is the fresh one. Show it and ask again. |
| `410` | `{ error: "plan_expired" }` | Preview again |
| `422` | `{ error: "plan_blocked", plan }` | The plan has blockers |
| `503` | `{ error }` | No receipt was taken; nothing ran. Retry. |

### When the template moves during the copy (#369)

GitHub's template copy takes no revision: it copies whatever the template head
is at that moment. So after the copy, and before anything else is written, the
new repository's initial tree is compared with the planned revision's tree.

If they differ (`revision_mismatch`), or the copy cannot be read within a few
seconds (`revision_unverified`), confirmation stops:
- the repository is kept exactly as GitHub created it: no placeholder commit,
  no provisioning, nothing deleted or rewritten;
- the receipt's status is `failed`, with steps `repo_created` and then
  `template_revision` (`fail`, detail prefixed with the code);
- the `200` response carries `status: "failed"` and the `error`.

Preview again. The new repository is then an untouched scaffold with no app
record, so the fresh plan offers `adopt_untouched` at the revision the copy
actually holds (`revisionSource: "scaffold_tree_match"`). Confirming it retries
the same receipt under that plan. This works because the platform itself marks
the failed receipt (`failureCode: "template_copy_mismatch"` or
`"template_copy_unverified"`). That mark is set only by the platform, never from
your session or from step text, and it is consumed by that one retry.

### Repeated confirmations

- **Concurrent:** while one confirmation of a plan is in flight, another gets
  `202` and joins it.
- **After a receipt is pending or completed:** the same plan returns that
  receipt (`joined: true`) and does not execute again, even after the preview
  expired.
- **After a receipt failed:** confirming again re-plans first. Usually the
  repository now exists, so the answer is `409` with a fresh plan. A failed
  receipt is retried only by the same request it was bound to, with one
  exception: a template-copy failure (below).
- **Across plans:** two plans for one app share one receipt; the second joins.

## 3. Progress

`GET /v1/provision-operations/{appId}` with the same session returns the
receipt:

```json
{ "receipt": "…", "appId": "school-clubs", "status": "pending", "steps": [{ "name": "repo_created", "status": "ok", "detail": "…" }],
  "createdAt": 0, "updatedAt": 0, "completedAt": null, "attemptCount": 1, "leaseExpiresAt": 0, "result": { "success": true, "appUrl": "…", "dataWorkerUrl": "…" } }
```

**Steps**, in order:
1. `repo_created`
2. `config_committed`
3. `compliance`
4. `r2_deploy`, `create_d1`, `deploy_worker`, `record_app`
5. `host`

`host` is `pending` until the first deploy serves. That means the app is
provisioned but not live yet; `ok` means the host responds. `result` appears
when the receipt is terminal.

## Source

| Piece | Location |
|---|---|
| Routes | `packages/backend/src/routes/provisioning-plans.ts` |
| Plans table | `migrations/0092_provisioning_plans.sql` |
| Workflow (`planProvision`, `executePlan`, `confirmPlan`) | `packages/mcp/src/provisioning-workflow.ts`, shared with the MCP `provision_pas_app` tool |
| Receipts | `packages/backend/src/routes/provision.ts` |
