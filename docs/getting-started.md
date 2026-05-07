# Getting Started

ProAppStore is the paid counterpart to FreeAppStore. Same Cloudflare Workers
+ D1 stack, plus Stripe-backed subscriptions, license keys, and premium
primitives.

> **v0 status: skeleton.** Public API surfaces are defined; backend
> implementations are stubs. The published packages compile and export the
> right types — bodies will land iteratively. Read the [strategy
> doc](https://github.com/proappstore-online/sdk/blob/main/STRATEGY.md) for
> the bet, then this site for how it fits together.

## Tech stack

- **TypeScript 5.7**, Node 22, pnpm workspaces
- **Backend:** Cloudflare Workers + D1 + Stripe
- **Frontend templates** (scaffolded by `pas init`): React 19 + Vite +
  Tailwind, deployed to Cloudflare Pages
- **Auth:** GitHub OAuth (shared with `fas`), HMAC-signed sessions,
  `SESSION_SIGNING_KEY` matched between `fas` and `pas` so identity
  carries across both
- **Payments:** Stripe (Checkout + Portal + webhook)

No Firebase. No alternative cloud. The bet is one provider, one runtime.

## Monorepo layout

```
sdk/
├── packages/
│   ├── cli/        # `pas` binary
│   ├── sdk/        # @proappstore/sdk (browser ESM, framework-agnostic)
│   └── backend/    # Cloudflare Worker — Stripe webhooks, entitlements, licenses
├── docs/           # this VitePress site
└── pnpm-workspace.yaml
```

Three packages mirror the free side's shape. Backend is one CF Worker with
its own `wrangler.toml` and (eventually) its own D1 database.

## Relationship to FreeAppStore

App developers building a free + pro pair import both SDKs:

```ts
import { initApp } from '@freeappstore/sdk';
import { initPro } from '@proappstore/sdk';

const fas = initApp({ appId: 'pipeline' });
const pas = initPro({ appId: 'pipeline' });

await fas.auth.init();                    // identity, KV, rooms

const sub = await pas.subscription.status();
if (sub?.tier !== 'pro') {
  pas.subscription.openCheckout({ priceId: 'price_...' });
}
```

The free SDK provides identity + per-user KV + Durable-Object rooms. The
pro SDK provides Stripe entitlements + license keys + premium primitives.
Same `userId` across both — the pro SDK validates the session signed by
`fas`.

## Key commands

```bash
pnpm install
pnpm build               # build all packages
pnpm test                # vitest across all packages
pnpm typecheck           # tsc -b across all packages

pnpm docs:dev            # local docs site (this site)
pnpm docs:build          # static build into docs/.vitepress/dist
```

## What to read next

- [Architecture](/architecture) — the three Workers and how they collaborate
- [Tailored vs Ready](/tailored-vs-ready) — the two app categories
- [Publishing flow](/publishing-flow) — what `pas publish` actually does
- [Stripe & entitlements](/stripe-entitlements) — billing primitives the
  pro SDK exposes
- [ADRs](/adr/001-cloudflare-workers-only) — load-bearing architectural
  decisions
