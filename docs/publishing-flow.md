# Publishing flow

`pas publish` is the publisher-facing command. It calls the PAS backend
`POST /v1/provision`, which delegates the cross-store steps (repo, Pages,
DNS, custom domain, registry) to the FAS admin Worker via service binding
and runs the PAS-specific steps (D1, Data Worker, apps row) locally.

## End-to-end sequence

```text
publisher                  PAS backend (api.proappstore.online)        FAS admin Worker (service binding)
  │                                       │                                       │
  ├─ pas publish ───────────────────────→ │                                       │
  │  (metadata)                           │                                       │
  │                                       ├─ env.ADMIN.fetch('/api/provision') ─→ │
  │                                       │   store: 'apps_pro'                   │
  │                                       │                                       ├─ 1. GitHub repo (proappstore-online)
  │                                       │                                       ├─ 2. CF Pages project (proappstore-<id>)
  │                                       │                                       ├─ 3. Custom domain (<id>.proappstore.online)
  │                                       │                                       ├─ 4. DNS CNAME
  │                                       │                                       ├─ 5. Storefront registry entry
  │                                       │ ←──── steps[] + success ───────────── │
  │                                       │                                       │
  │                                       ├─ 6. Create D1 database (pas-data-<id>)
  │                                       ├─ 7. Deploy Data Worker bound to that D1
  │                                       ├─ 8. INSERT INTO apps (id, creator_id, …)
  │                                       │
  │ ←──── result + URL ─────────────────  │
  │
  └─ git push origin main
     auto-deploys via CF Pages in ~30s
```

Service-binding fetches go Worker→Worker on the same CF account and bypass
CF Access entirely, so PAS doesn't need a JWT or service token to call
FAS admin — the binding itself is the auth.

## Why this shape

- **Single control plane for repo/CF/DNS/registry.** Same Worker
  provisions FAS, FGS, and now PAS, so secrets (GitHub admin:org token,
  CF API token with Pages + DNS scope) only live in `fas/admin`.
- **PAS-specific steps stay in PAS.** D1 and the per-app Data Worker
  are concepts only the pro side has; no reason to leak them into
  `fas/admin`'s surface area.
- **Idempotent.** Re-running `pas publish` on a partially-provisioned
  app fills in only the missing pieces — every step checks existence
  before creating.

## What `POST /api/provision` does, by category

Both categories share steps 1–4 and 6. **Step 5 is the meaningful split.**

| # | Action | Tailored | Ready |
|---|---|---|---|
| 1 | `POST /orgs/<org>/repos` (empty repo, `auto_init: false`) | per-fork repo | one repo per publisher |
| 2 | CF Pages project wired to the repo via GitHub integration | yes | yes |
| 3 | Custom domain `<id>.<storezone>` | yes | yes |
| 4 | DNS CNAME `<id> → <pages-domain>` | yes | yes |
| 5 | **D1 database `db_<id>` + binding registered with the Pages project** | **yes** | **no** |
| 6 | Append entry to storefront `registry.json` | yes | yes |

Failure of step 2 or 3 (most common: CF Pages GitHub-app not installed
on the org) skips step 6 to avoid leaving dead-link entries on the
storefront.

## Step 5 in detail (Tailored)

Currently a planned addition to `fas/admin`. The expected shape:

```text
POST https://api.cloudflare.com/client/v4/accounts/<account>/d1/database
Authorization: Bearer ${CF_API_TOKEN}

{
  "name": "db_<id>"
}
```

Then bind to the Pages project:

```text
PATCH .../pages/projects/<project>/deployments/configs/production

{
  "d1_databases": {
    "DB": { "id": "<the-d1-id-just-created>" }
  }
}
```

The forked Tailored app's `wrangler.toml` already declares
`[[d1_databases]] binding = "DB"` and runs `pnpm db:migrate:remote` on
first boot. The provisioning step ensures the binding resolves.

A future enhancement: kick off the initial migration as part of provisioning,
so the user's first `git push` finds an already-migrated DB. Deferred until
the migration runner is robust enough to run from the admin context.

## Why provisioning runs in admin, not pas

Provisioning needs CF API tokens with broad scope: GitHub admin:org +
CF account-level Pages and DNS edit. Concentrating those secrets in
`fas/admin` (one Worker, narrow surface, CF Access fronted) is the
security posture. `pas` doesn't need them — it deals with Stripe,
which has its own secret set.

## The category flag

`POST /api/provision` accepts `category: 'tailored' | 'ready'`. The
flag drives:

- Whether step 5 (D1) runs.
- Which storefront listing template to register against (different
  listing-page UIs).
- Which onboarding path the publisher's Pages project links to (fork-it
  guide vs sign-up flow).

The flag lands on the registry entry too, so the storefront can filter
on it.

## Failure modes

| Symptom | Cause | Recovery |
|---|---|---|
| 522 from `fas` → admin | edge loop (do not call `admin.freeappstore.online` directly from `fas`; use the service binding) | already fixed in `fas/wrangler.toml` |
| `Pages GitHub app not installed` | CF Pages app not added to the GitHub org | skip step 6, surface the error to the publisher |
| `D1 quota exceeded` | account-level D1 limit reached | block provisioning, alert |
| `repo already exists` | publisher retried, repo from previous attempt left over | safe to ignore if state matches; otherwise abort and ask the publisher |
| DNS race | CNAME created before custom domain registration completed | retry once; the Pages API is idempotent here |

## Testing locally

`fas/admin` has a vitest suite that mocks the GitHub + CF Pages + DNS
APIs. Run `pnpm test` in `~/personal/fas/admin`. The test file
`src/test/security.test.ts` scans the source for known token patterns
and previously-leaked credentials — it's caught real regressions, don't
disable it.

## Related ADRs

- [ADR-002](/adr/002-tailored-vs-ready-split) — why the category split exists
- [ADR-003](/adr/003-one-control-plane) — why one Worker handles both paths
- [ADR-005](/adr/005-d1-per-fork) — why each Tailored fork gets its own D1
