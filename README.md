# ProAppStore Platform

Unified SDK + CLI + backend for premium apps on **proappstore.online**.

## SDK

```bash
npm i @proappstore/sdk
```

```ts
import { initPro } from '@proappstore/sdk'

const app = initPro({ appId: 'my-app' })

app.auth          // PAS-owned auth: GitHub default, Google, email magic links
app.kv            // Per-user key-value storage
app.counters      // Shared atomic counters
app.rooms         // Real-time WebSocket rooms
app.roles         // App-level roles and permissions
app.proxy         // Secret-injecting API proxy
app.db            // Per-app SQL database (D1)
app.subscription  // Stripe subscriptions (pro)
app.license       // License key validation (pro)
```

One import. All platform features in one SDK instance.

## Packages

| Package | npm | Description |
|---------|-----|-------------|
| `packages/sdk` | `@proappstore/sdk` | Unified browser SDK |
| `packages/cli` | `@proappstore/cli` | CLI for publishing pro apps |
| `packages/backend` | private | CF Worker — Stripe webhooks, subscriptions, licenses |
| `packages/data-worker` | private | Per-app D1 database worker (`data-{appId}.proappstore.online`) |

## Architecture

```
Browser App
  └─ @proappstore/sdk
       ├─ auth, kv, counters, rooms, proxy → api.proappstore.online (PAS backend)
       ├─ subscription, license            → api.proappstore.online
       └─ db                               → data-{appId}.proappstore.online (data-worker)
```

- **Backend** (`packages/backend`): Cloudflare Workers + D1 — auth, app registry, roles, Stripe webhooks, subscription CRUD, license key management, proxy, storage, notifications, and platform services
- **Data Worker** (`packages/data-worker`): Per-app Hono worker fronting a D1 database — query, execute, batch, tables. Auth validates PAS session JWTs locally.
- **Auth**: PAS owns sessions and `/v1/auth/*`; GitHub is the default OAuth provider, with Google and email credential flows also supported by the SDK/API.
- **Payments**: Stripe (checkout sessions, billing portal, webhook receiver)
- **Publishing**: OIDC trusted publishing (no stored tokens)

## Development

```bash
pnpm install
pnpm build          # build all packages
pnpm test           # run tests
```

## Deployment

- Push to main → auto-deploy backend + data-workers via GitHub Actions
- SDK/CLI auto-publish to npm via OIDC on version bump

## License

MIT.
