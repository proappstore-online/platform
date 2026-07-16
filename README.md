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
| `packages/backend` | private | CF Worker — auth, registry, roles, Stripe, storage, **QA flows/runs** |
| `packages/host` | private | R2 host Worker — serves apps at `*.proappstore.online`, mediation, **`/__qa/` runner** |
| `packages/mcp` | private | MCP server — app tools + **QA tools** (`qa_list_flows`, `qa_run`, …) |
| `packages/mcp-registry` | `@proappstore/mcp` | npm-published MCP Registry entry — thin `mcp-remote` wrapper → `mcp.proappstore.online/mcp` |
| `packages/admin` | private | Provisioning worker |
| `packages/compliance` | private | Compliance checks |
| `packages/data-worker` | private | Per-app D1 database worker (`data-{appId}.proappstore.online`) |
| `packages/agent-teams` | private | Autonomous build (PO/BA/Dev/QA agents) |
| `packages/build-core` | private | Shared build logic (GitHub repo create, git push) |
| `packages/kb-host` | private | Knowledge base host (static KB → R2) |
| `packages/qa-spec` | private | Browser e2e test-flow format: types, validator, DOM runner, Playwright transpiler |
| `packages/qa-worker` | private | Headless QA executor — runs flows in Cloudflare Browser Rendering |

## Browser e2e testing (QA)

App flows (sign in, join a tournament, solve a puzzle) get first-class,
platform-run automation — **no test code in the app repo**:

- **One flow spec** (`@proappstore/qa-spec`, JSON steps) runs three ways from a
  single DOM-runner implementation (no resolver drift):
  1. **Observable runner** — `https://<appId>.proappstore.online/__qa/`: watch
     each step execute live in the app (same-origin iframe), owner-gated.
  2. **Headless** — `packages/qa-worker` on Cloudflare Browser Rendering, run
     after every deploy (keyless GitHub OIDC) and on a cron.
  3. **Playwright** — `toPlaywright()` emits a `.spec.ts` for CI parity.
- **Specs live in platform D1** (`app_test_flows`), never the app repo.
- **Auth**: app owner, or a scoped **QA API key** (`X-QA-Key`) so agents/CI
  never hold a session token. Mint via `POST /v1/apps/:appId/qa/keys`.
- **Write + run over MCP** (`mcp.proappstore.online`): `qa_save_flow`, `qa_run`,
  `qa_list_runs`, `qa_run_artifacts`, `qa_flow_playwright`, `qa_mint_key`, …
- **QA agent**: the PAGS `qa-automation` agent authors + runs flows with a QA
  mindset, separate from the dev/build loop.

See `packages/qa-spec/README.md` and `packages/qa-worker/README.md`.

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
