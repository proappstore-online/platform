# proappstore-admin

ProAppStore admin Worker: automated app provisioning.

**Status:** v0.2 — deployed, publish flow live.

**URL:** `https://proappstore-admin.serge-the-dev.workers.dev`
(Custom domain `admin.proappstore.online` DNS exists, Workers Route pending)

## What it does

`POST /api/publish-app` provisions a new PAS app end-to-end:

1. Create GitHub repo in `proappstore-online` org
2. Create CF Pages project `proappstore-{id}`
3. Add custom domain `{id}.proappstore.online` to Pages
4. Create DNS CNAME → `proappstore-{id}.pages.dev`
5. Add entry to storefront `registry.json`
6. Provision CF Web Analytics RUM site

Idempotent — re-running on a partially-provisioned app fills in only missing pieces.

## Secrets (already set)

| Secret | Purpose | Token name in CF dashboard |
|---|---|---|
| `CF_API_TOKEN` | Pages:Edit + DNS:Edit on `proappstore.online` | `ProAppStore Admin Worker` |
| `GITHUB_TOKEN` | Fine-grained PAT for `proappstore-online` org (Contents + Admin R/W) | `ProAppStore Admin Worker` |

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

**Note:** No auth on the endpoint yet. Add CF Access or bearer token before exposing publicly.

## Layout

```
admin/
├── src/
│   ├── index.ts     ← router: /health, /api/publish-app
│   ├── publish.ts   ← 7-step publish handler
│   └── env.ts       ← binding types
├── wrangler.toml
└── package.json
```

## Deploy

```
pnpm install
wrangler deploy
```

Per `ci-cd-canonical` convention, production deploys should go via GitHub Actions once CI is set up for this repo.
