# ProAppStore SDK

Paid SDK + CLI + backend for apps published on **proappstore.online**.

> **v0 status: skeleton.** Public API surfaces are defined; implementations are stubs that point at where the work lives. Production-ready modules will land iteratively.

## Relationship to FreeAppStore SDK

The free side lives at [freeappstore-online/sdk](https://github.com/freeappstore-online/sdk) and ships the **`fas` CLI + `@freeappstore/sdk`** with auth, per-user KV, and Durable-Object rooms — free forever.

This repo is the **pro counterpart**: `pas` CLI + `@proappstore/sdk`, focused on what makes a paid app a paid app:

- Stripe-backed subscriptions (open checkout, manage subscription portal, read status)
- License-key minting + validation
- Higher per-user / per-app quotas
- Premium modules (TBD: real-time multiplayer with persistence, AI/LLM proxy, etc.)

App developers import **both** when building a free+pro pair:

```ts
import { initApp } from '@freeappstore/sdk';
import { initPro } from '@proappstore/sdk';

const fas = initApp({ appId: 'bandmates' });
const pas = initPro({ appId: 'bandmates' });

// Free: identity, per-user KV, light rooms
await fas.auth.init();

// Pro: subscription state on top of the free user
const subscription = await pas.subscription.status();
if (subscription?.tier !== 'pro') {
  pas.subscription.openCheckout({ priceId: 'price_...' });
}
```

## Layout

```
sdk/
├── packages/
│   ├── cli/        # `pas` binary
│   ├── sdk/        # @proappstore/sdk
│   └── backend/    # CF Worker — Stripe webhooks, entitlements, licenses
├── docs/
└── pnpm-workspace.yaml
```

## What's not in v0 skeleton

The structure compiles, exports the right types, and has CI green. But almost every method body is a TODO that throws or returns a typed stub. The next iteration wires:

1. Stripe checkout + portal + webhook receiver
2. D1 schema for `subscriptions` and `license_keys`
3. Entitlement check that gates premium modules

## Stack

Same as the free side: TypeScript 5.7, Node 22, pnpm, Cloudflare Workers + D1 (+ Stripe).

## License

MIT. See [LICENSE](./LICENSE).
