# Deferred plan — buying domains through PAS

Status: **deferred**. Captured 2026-05-21 alongside the BYO custom-domain ship
(commits `64a6d81` on `fas/admin`, `3691fc6` on `pas/platform`).

## Why this isn't in v1

The BYO flow that just shipped covers "owner already has a domain and wants
to point it at their Pro app." A natural next ask is "let me **buy** a
domain through PAS so I don't have to leave the platform." That's what this
doc covers — and why it isn't built yet.

## What we'd be selling

Three plausible product shapes:

### A. Pure referral (no money in our pipeline)

Owner clicks "I need a domain" → we deep-link them to Cloudflare Registrar
(or Porkbun, or Namecheap) → they buy under their own account → they come
back with a hostname and run `pas domain add example.com` exactly as today.

- **Effort:** maybe a day of UI + a quick "where to buy" doc page.
- **Revenue:** zero (or a small affiliate cut if the registrar offers one;
  CF doesn't).
- **Risk:** zero. The owner's domain stays in the owner's CF account; if
  they churn off PAS they take their domain with them.
- **Verdict:** ship this the moment we have a console UI for domains.

### B. Resale via our CF account (we hold the registration)

Owner clicks "Buy example.com" → we charge their card via Stripe → we
call CF Registrar's API on **our** account → the domain ends up in *our*
CF account, the owner gets to use it on their PAS app.

- **Effort:** ~1 week of real work. Stripe surcharge flow, CF Registrar
  API integration, renewal billing job, churn / refund / cancellation
  handling, transfer-out flow when an owner wants to leave.
- **Revenue:** zero direct markup possible — ICANN + CF Registrar's terms
  require at-cost resale; we'd be running this as a convenience, not a
  profit center.
- **Risk:** high.
  - **Chargeback risk:** owner disputes the charge → Stripe pulls the
    money → we still owe CF for the registration → we eat the cost.
  - **Lockout risk:** owner churns off PAS but their business depends on
    the domain → painful transfer process, support load, reputation hit
    if we ever get this wrong.
  - **Renewal billing:** PCI + dunning + grace-period UX, all for
    something that isn't our core product.
  - **TLD coverage:** CF Registrar supports ~40 TLDs. Owners who want
    `.io`, `.dev`, etc. fall back to Porkbun anyway.
- **Verdict:** **don't build this.** The risk/reward ratio is bad and
  every platform that *does* sell domains (Vercel, Netlify, Fly) ends
  up regretting it. They all eventually push customers to Porkbun
  or Cloudflare and just maintain the BYO flow.

### C. Resale via owner's CF account (we drive their checkout)

Owner connects their Cloudflare account via OAuth → we drive a purchase
flow that ends with the domain in *their* CF account → they then run
`pas domain add example.com` like BYO.

- **Effort:** ~3 days. CF OAuth, scoped token storage, a thin "buy"
  wizard that calls CF Registrar on the owner's behalf.
- **Revenue:** zero direct.
- **Risk:** medium. We're holding a delegated CF token, which is a real
  secret to manage. But the domain lives with the owner — none of the
  chargeback / lockout problems of (B).
- **Verdict:** **maybe** — but only if there's evidence owners actually
  want this. CF's own purchase UX is already pretty good; we'd have to
  beat it to justify the OAuth complexity.

## Recommendation

1. When the console UI for custom domains lands, also ship option (A):
   a small "Need a domain? We recommend Cloudflare Registrar (cheapest,
   no markup) or Porkbun (widest TLD support)" panel. One day of work,
   zero risk, covers ~90% of the "but where do I buy?" question.
2. Revisit (C) only if owners ask for in-platform purchase 5+ times.
   Track the ask in support / Slack until then.
3. Never build (B). The risk profile is wrong for what we'd gain.

## What changes if we revisit

The signal we'd be looking for is: BYO adoption is high (≥30% of Pro
apps), AND the "buy a domain" friction shows up as a real abandonment
cause in onboarding telemetry. Until both are true, the right answer is
"recommend Cloudflare Registrar."

CF Registrar API reference (for future-me):
<https://developers.cloudflare.com/api/operations/registrar-domains-list-domains>
