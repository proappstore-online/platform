# SDK overview

`@proappstore/sdk` is a browser-first ESM package that any app — Tailored
or Ready — imports to add paid behavior on top of `@freeappstore/sdk`'s
identity layer.

> **v0 status: skeleton.** Public API surfaces below are stable; bodies
> are TODO stubs. The shapes won't change as implementations land.

## Init

```ts
import { initPro } from '@proappstore/sdk';

const pas = initPro({
  appId: 'pipeline',                       // required
  apiUrl: 'https://api.proappstore.online', // optional, defaults shown
});
```

The init call is synchronous and cheap. It does not fetch anything; the
first network call happens when you read entitlements or open Checkout.

## Surfaces

```ts
pas.subscription          // Stripe subscription helpers
  .status()               // → { tier, priceId, currentPeriodEnd, cancelAtPeriodEnd } | null
  .openCheckout(opts)     // → redirects to Stripe Checkout
  .openPortal()           // → redirects to Stripe Customer Portal

pas.licenseKey            // license keys
  .mint(opts)             // → string (server-side)
  .validate(key)          // → { ok: true, appId, email, metadata, mintedAt } | { ok: false, reason }

pas.entitlements          // cross-cutting "can this user do X right now"
  .check({ feature, quota? })
                          // → { ok: true } | { ok: false, reason: 'tier-too-low' | 'quota-exceeded' | 'no-license' }
  .quota(name)            // → { used, limit, resetAt }

pas.premium               // future: real-time multiplayer with persistence,
                          //         AI/LLM proxy, advanced storage tiers
```

## Pairing with the free SDK

The pro SDK assumes the free SDK is in use for identity. Both validate
the same HMAC session minted by the `fas` Worker. Same `userId` across
both calls.

```ts
import { initApp } from '@freeappstore/sdk';
import { initPro } from '@proappstore/sdk';

const fas = initApp({ appId: 'pipeline' });
const pas = initPro({ appId: 'pipeline' });

await fas.auth.init();                 // GitHub OAuth via api.freeappstore.online

const sub = await pas.subscription.status();
if (sub?.tier !== 'pro') {
  pas.subscription.openCheckout({ priceId: 'price_...' });
}
```

If you only need identity / KV / rooms, you don't need the pro SDK.
If you only need Stripe / entitlements without identity, that's a design
smell — billing without identity is rarely what you want.

## Framework-agnostic on purpose

`@proappstore/sdk` does not pin React, Vue, Svelte, or any UI framework.
It's pure browser ESM with TypeScript types. Pinning React would be a
peer-dep footgun (dual React in the bundle is a real risk in monorepos).

The scaffolds emitted by `pas init` use React 19 + Vite + Tailwind, but
that's a template choice, not an SDK requirement.

## Errors

All async methods return a result type rather than throwing for expected
failures:

```ts
const r = await pas.entitlements.check({ feature: 'rooms' });
if (!r.ok) {
  switch (r.reason) {
    case 'tier-too-low': /* show upgrade CTA */ break;
    case 'quota-exceeded': /* show quota UI */ break;
    case 'no-license': /* show license entry */ break;
  }
}
```

Network / server errors throw a typed `ProAppStoreError` with `code` and
`status`.

## Caching

`pas.subscription.status()` and `pas.entitlements.check()` cache for 60s
in-memory by default. Pass `{ fresh: true }` to force a network call.
The webhook receiver in `pas` invalidates server-side rows; the SDK can't
know about that, hence the short TTL.

## Source

- Package: `~/personal/proapps/sdk/packages/sdk`
- Backend: `~/personal/proapps/sdk/packages/backend` (calls into here)
- Tests: `vitest` per package; integration tests run against
  `wrangler dev --local` for the backend.
