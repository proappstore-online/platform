# proappstore-admin

ProAppStore admin Worker: automated app provisioning.

**Status:** v0.2 — deployed, publish flow live.

**URL:** `https://proappstore-admin.serge-the-dev.workers.dev`
(Custom domain `admin.proappstore.online` DNS exists, Workers Route pending)

## What it does

`POST /api/publish-app` provisions a new PAS app end-to-end. This is **Path B**
hosting — a single host Worker + R2, no per-app CF Pages project:

1. Create GitHub repo in `proappstore-online` org
2. Grant the creator push access to their repo (non-fatal)
3. Insert an R2 route (`<id>.proappstore.online → apps/<id>/`) into the host
   Worker's `routes` table in D1
4. Add entry to storefront `registry.json`
5. Provision CF Web Analytics RUM site (non-fatal)
6. Dispatch the `reconcile-app-secrets` workflow so the new repo gets R2 deploy
   creds as repo-level secrets before its first deploy

Idempotent — re-running on a partially-provisioned app fills in only missing pieces.
The same provisioning core also backs `/api/agent-deploy` (Agent Teams deploy)
and a durable Cloudflare Workflow variant (`/api/provision-workflow`).

## Secrets (already set)

| Secret | Purpose |
|---|---|
| `CF_API_TOKEN` | CF API token — provisions the CF Web Analytics RUM site (Path B needs no per-app Pages/DNS) |
| `GITHUB_TOKEN` | Fine-grained PAT for `proappstore-online` org (Contents + Admin R/W) |
| `SESSION_SIGNING_KEY` | HS256 key (shared with FAS auth) — verifies the Bearer session token on `/api/publish-app` |
| `INTERNAL_TOKEN` | Shared secret for internal service-to-service calls (e.g. agent-teams → `/api/agent-deploy`) |

## Usage

```bash
curl -X POST https://proappstore-admin.serge-the-dev.workers.dev/api/publish-app \
  -H "Content-Type: application/json" \
  -d '{
    "id": "my-app",
    "name": "My App",
    "category": "productivity",
    "icon": "&#128295;",
    "iconBg": "#f0f9ff",
    "description": "Short description"
  }'
```

**Auth:** `/api/publish-app` requires a verified Bearer session token (validated
against `SESSION_SIGNING_KEY`); internal endpoints use `INTERNAL_TOKEN`.

## Layout

```
admin/
├── src/
│   ├── index.ts              ← router: /health, /v1/auth/*, /api/publish-app,
│   │                            /api/agent-deploy, /api/publish-kb, /api/repo-pull,
│   │                            /api/deploy-status, /api/provision-workflow*, /api/apps
│   ├── publish.ts            ← Path B provision core (repo + R2 route + registry + analytics)
│   ├── provision-workflow.ts ← durable Cloudflare Workflow variant
│   ├── auth.ts               ← session-token verification
│   ├── e2e-harness.ts        ← injected Playwright E2E workflow
│   └── env.ts                ← binding types
├── wrangler.toml
└── package.json
```

## Deploy

```
pnpm install
wrangler deploy
```

Per `ci-cd-canonical` convention, production deploys should go via GitHub Actions once CI is set up for this repo.
