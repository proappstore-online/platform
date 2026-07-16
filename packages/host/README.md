# proappstore-host

ProAppStore host Worker: serves every published app from R2 via subdomain
routing at `<slug>.proappstore.online`. Path B canonical implementation
for PAS.

**Status:** live (v1.0.0). Wildcard route `*.proappstore.online/*` enabled;
serves apps from R2 and dispatches reserved subdomains.

## Origin

Vendored pattern from `fas/host` (per `cross-store-pattern-flow` memory).
FAS host is the closest match for PAS because both serve apps at
wildcard subdomains (`<slug>.zone`) — `fws/host` is path-based at a
single hostname and a less close fit.

## Why this exists (Path B)

Per the `path-b-canonical-hosting` memory: "host Worker + R2 is canonical
for all new store admin Workers; never add `pages/projects` calls."
Per `cf-pages-project-limit`: CF Pages caps at 100 projects per account,
and we already burned 69 of them. The Path B pattern (single host Worker
+ R2 prefix per app) scales to thousands of apps without provisioning
per-app CF resources.

## Critical: wildcard route preemption

Per the `wildcard-worker-route-preemption` memory:

> a `*.zone/*` Worker route preempts every sibling Worker custom_domain
> + CF Pages binding on that zone; enumerate every subdomain before
> deploying any such wildcard

The `*.proappstore.online/*` route on this Worker preempts every sibling
subdomain on the zone. The Worker dispatches the reserved subdomains
(`RESERVED_SUBDOMAINS` in `src/host.ts`): `api`, `admin`, `agents`, `mcp`,
`kb`, `docs`, `www`, `console`, `dashboard` — plus `data-*.proappstore.online`
(per-app D1 Workers, proxied via fetch since they're created dynamically).
`api`/`admin`/`agents`/`mcp`/`kb` go over zero-hop service bindings; `console`
and `dashboard` are proxied to their CF Pages projects. See the dispatch
branches at the top of `src/index.ts`.

## Layout

```
host/
├── package.json          ← @proappstore/host (private)
├── tsconfig.json
├── wrangler.toml         ← wildcard route *.proappstore.online/* ENABLED
├── biome.json
├── .gitignore
├── README.md
└── src/
    ├── index.ts          ← reserved-subdomain dispatch + R2 serve
    ├── env.ts            ← binding types
    ├── host.ts           ← slugFromHostname + RESERVED_SUBDOMAINS + route lookup
    ├── auth-handler.ts   ← same-origin platform auth routes
    ├── platform-mediation.ts ← platform SDK mediation
    ├── meta-rewriter.ts  ← injects listing/tenant meta tags into served HTML
    └── qa-runner.ts      ← observable QA runner served at /__qa/
```

## Pre-deploy checklist (stage 0)

1. **Verify the reserved-subdomain list is complete.** Run:
   ```
   wrangler routes list --zone-id 14928daaff60902cc89003a2ebeb99fe
   ```
   Every Worker currently bound on a subdomain MUST be in `RESERVED_SUBDOMAINS`
   with a corresponding service binding + dispatch branch. Missing one breaks
   the live site the moment the wildcard route activates.
2. Create R2 bucket:
   ```
   wrangler r2 bucket create pas-apps   # if pas/admin didn't already
   ```
3. Create D1 routes table:
   ```
   wrangler d1 execute pas --file=migrations/0001_create_routes.sql
   ```
   (Schema lands in stage 0; mirror fas/host/migrations.)
4. Wire service bindings in wrangler.toml (ADMIN, API).
5. Add dispatch branches to `src/index.ts`.
6. **In a staging zone first**, enable the wildcard route. Verify every
   currently-bound subdomain still responds.
7. Deploy to production via GitHub Actions (per `ci-cd-canonical`).

## Build

```
pnpm install
pnpm typecheck
```

## Design reference

`~/.gstack/projects/serge-ivo-stores-workspace/serge-ivo-main-design-20260521-181709.md`
