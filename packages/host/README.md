# proappstore-host

ProAppStore host Worker: serves every published app from R2 via subdomain
routing at `<slug>.proappstore.online`. Path B canonical implementation
for PAS.

**Status:** v0.1 scaffolding. Not deployed. No GitHub remote yet.

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

The `*.proappstore.online/*` route on this Worker preempts:
- `admin.proappstore.online` (pas/admin Worker)
- `api.proappstore.online` (pas/platform/packages/backend)
- `data-*.proappstore.online` (pas/platform/packages/data-worker, per-app D1)
- any future subdomain Worker on this zone

So this Worker MUST dispatch reserved subdomains via service bindings.
See `RESERVED_SUBDOMAINS` in `src/host.ts` and the dispatch branches in
`src/index.ts` (stage-0 work).

## v0.1 Layout

```
host/
├── package.json     ← @proappstore/host (private)
├── tsconfig.json
├── wrangler.toml    ← scaffolded; route NOT enabled (wildcard caution)
├── biome.json
├── .gitignore
├── README.md
└── src/
    ├── index.ts     ← Wildcard dispatch + R2 serve (stub in v0.1)
    ├── env.ts       ← binding types
    └── host.ts      ← slugFromHostname + RESERVED_SUBDOMAINS
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
