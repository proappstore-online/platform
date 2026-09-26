# Publishing flow

> **App requirements** around publishing — CLI-managed lifecycle, no manual infrastructure, deploy evidence — are [PAS-STACK-004](./standard/stack.md#pas-stack-004) and [PAS-OPS-005](./standard/ops.md#pas-ops-005) in the [Application Standard](./standard/index.md).

`pas publish` calls `POST /v1/provision` on the PAS backend
(`api.proappstore.online`). The PAS platform owns the full publish flow —
no delegation to FAS or any other store's admin.

## End-to-end sequence

```text
publisher                  PAS backend (api.proappstore.online)
  |                                       |
  |-- pas publish (/v1/provision) ------> |
  |   (metadata)                          |
  |                                       |-- 1. Validate app id
  |                                       |-- 2. Compliance check (fetch repo from GitHub, run checks)
  |                                       |-- 3. Register R2 host route (D1 routes table — Path B, no CF Pages)
  |                                       |-- 4. Create per-app D1 database `pas-data-{id}`
  |                                       |-- 5. Deploy `data-{id}.proappstore.online` worker
  |                                       |-- 6. Insert app record (platform apps table)
  |                                       |
  | <---- result + URL ---------------    |
  |
  +-- register mcp.json tools (PUT /v1/apps/{id}/tools) + dispatch R2 deploy-secret reconcile
  |
  +-- git push origin main
     GitHub Actions deploy (keyless OIDC), in order:
       build -> migrate (migrations.json) -> upload to R2 -> register mcp.json tools
```

The deploy order matters: `migrations.json` is applied to D1 **before** the new
frontend uploads and **before** `mcp.json` tools register, so a registered action
never references a column that isn't there yet (§10; see
`app-actions-security.md`). The migrate step is hard-gated — a migration failure
fails the deploy. Additive-only (`CREATE`/`ALTER … ADD`/`INSERT`); destructive
SQL is rejected with 422.

## Keyless e2e sessions

A workflow that drives the deployed app as a signed-in user (a nightly e2e
suite) gets its session the same keyless way it gets its deploy credentials
(#146). A platform admin grants the repository once:

```
POST /v1/admin/oidc-session-grants
{ "repository": "proappstore-online/chess-academy",
  "workflow": ".github/workflows/e2e-full.yml", "user_id": "gh:<e2e account>" }
```

Then the workflow (with `permissions: id-token: write`) exchanges its OIDC
token — nothing stored in the repo:

```bash
OIDC=$(curl -sS -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
  "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=https://api.proappstore.online" | jq -r .value)
SESSION=$(curl -sS -X POST https://api.proappstore.online/v1/auth/exchange/oidc \
  -H "Authorization: Bearer $OIDC" | jq -r .sessionToken)
```

The session is a real platform session for the granted account (four hours,
`via: 'oidc-e2e'`, roles `user` + `creator`, never `admin`). Every mint is
recorded against the grant; revoking the grant stops the next run with 403.
`POST /v1/auth/exchange` (device-flow token → session) stays for the CLI and
laptop runs.

## Key properties

- **Standalone.** The PAS backend has its own Cloudflare/GitHub credentials for
  R2 host routes, D1, data-worker deploys, and repo setup. No cross-store service
  bindings.
- **Idempotent.** Re-running on a partially-provisioned app fills in only missing pieces.
- **CLI-driven.** `pas publish` is the intended entrypoint; it calls
  `POST /v1/provision`. Each subsequent `git push` runs the keyless deploy, which
  applies `migrations.json` then re-registers `mcp.json` app tools (both when present).

## Storefront listing copy

After publishing, the owner edits the storefront copy with
`PUT /v1/apps/:id/listing`, which merges the fields sent and leaves the rest
unchanged. The `tagline` and `longDescription` appear under the platform's name: on
the proappstore.online storefront, and as the link-preview `og:description` of every
page of the app. Edits made after approval skip the submission review, so this text
is **moderated by Workers AI** (Llama Guard) before it is written (#214):

- Moderation runs only when one of these fields changes to a new, non-empty value,
  with one model call for both. Unchanged text, cleared text and every other field
  are never moderated.
- Unsafe text is a `422` with the categories. **Nothing** from that request is
  written, including other fields sent in the same patch.
- If moderation is unavailable, the answer is a `503` with `Retry-After: 5`. It
  fails closed; retry shortly.
- Each decision is logged as `listing_moderation` (app, actor, changed fields,
  verdict), never with the text.

## Failure modes

| Symptom | Cause | Recovery |
|---|---|---|
| `repo already exists` | Retry after partial failure | Safe if state matches; otherwise abort |
| Compliance `412` | A hard compliance rule failed on the fetched repo | Fix the flagged rule and re-run; the step lists each failure |
| `D1 quota exceeded` | Account-level D1 limit reached | Block provisioning, alert |
| Listing edit `422` | The new tagline or long description failed content moderation | Rewrite the copy; nothing was saved |
| Listing edit `503` | Workers AI moderation unavailable | Retry after `Retry-After`; nothing was saved |

## Testing

PAS provisioning has vitest suites mocking the GitHub + CF APIs. Run `pnpm test`
in `packages/backend/` (the `/v1/provision` route) and `packages/admin/` (the
shared `provisionApp` / `runProvisionSteps` core).
