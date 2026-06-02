# Agent Teams: runtime choice & billing options

Research + decisions for how PAS Agent Teams runs AI agents and how usage could be
billed. Checked against current Anthropic docs (June 2026). See also
`packages/agent-teams/` and the architecture memory.

## Decision: we run our own agent loop (not Claude Managed Agents)

PAS Agent Teams runs **its own agentic loop** in the Worker:
- `cf-native` — raw Anthropic Messages API + our tool loop (`runtimes/cf-native.ts`)
- `openai-responses` — OpenAI Responses API + our tool loop

We do **not** use Anthropic-hosted "Managed Agents." This is deliberate and is the
only option that satisfies "run on the customer's own account/key."

## Why not "run in the user's own Anthropic account"?

We investigated provisioning/running Claude **Managed Agents** on behalf of users,
billed to the user's own Anthropic account. Findings (Anthropic docs, June 2026):

1. **Claude Managed Agents exists** — a hosted REST API where Anthropic runs the
   agent loop + sandboxed tools for you
   (https://platform.claude.com/docs/en/managed-agents/overview, beta Apr 2026).
   Pricing: tokens + ~$0.08/session-hour + tool costs. **But it always runs under
   the *caller's* API key + billing.** There is no parameter to bill it to an end
   user. Stateful by design → ineligible for ZDR / HIPAA BAA.

2. **No delegated access / "Connect your Anthropic account."** Anthropic offers no
   third-party OAuth, no "Sign in with Anthropic," no app-consent flow (third-party
   OAuth was banned in early 2026; subscription tokens may not be used in
   third-party tools). The **only** supported way to use a customer's account is
   **BYOK — they paste their API key.**

3. **Admin API cannot create keys.** It manages *existing* keys + workspaces +
   members within *one* org; it explicitly cannot mint new API keys ("Console only,
   for security") and cannot reach into a customer's org
   (https://platform.claude.com/docs/en/manage-claude/admin-api).

4. **No billing passthrough / reseller / sub-accounts / usage attribution.**
   Anthropic bills the account that owns the key. There is no partner/reseller
   program for reselling compute.

5. **Agent SDK in serverless:** the SDK (run-your-own-loop) can run in CF Workers;
   Managed Agents runs the loop on Anthropic with the sandbox optionally on
   Cloudflare. We don't need either — our loop is already in the Worker.

> Caveat: Managed Agents existence + Admin API limits are from official docs; the
> OAuth-ban and the June-2026 subscription billing-split specifics came from
> secondary sources (VentureBeat / The Register / Medium) — treat those dates as
> approximate.

### Consequence

|                    | Bills to        | Who runs the loop | BYO key |
|--------------------|-----------------|-------------------|---------|
| **Our loop + BYO** | the **user**    | us (in-Worker)    | yes     |
| Managed Agents     | **us** (platform)| Anthropic        | no      |

The only way to have the user's account pay is **BYOK + our own loop** — which is
what's shipped. Adopting Managed Agents would flip us to "platform pays."

## Runtime implementation (current)

Both adapters run an in-Worker tool loop. Shipped hardening:

- **Streaming** (`cf-native`): the Anthropic Messages call uses `stream: true` and
  a custom SSE parser. A large non-streamed completion (e.g. the Dev writing files
  at 16k `max_tokens`) could exceed Cloudflare's ~100s edge timeout and fail with
  **524**; streaming flushes the first byte immediately so it never trips.
- **Transient retry**: 429/5xx (incl. 524/504) retried up to 3× with backoff.
- **Truncation recovery**: a `max_tokens`-truncated turn with no tool calls is
  continued ("Continue."), not treated as done — fixed agents "going in circles".
- **Per-role `max_tokens`** is configurable (`role_configs.max_tokens`); defaults
  Dev 16384 / BA·QA 8192.
- **Prompt caching**: system + tools + the rolling last message are marked
  `cache_control: ephemeral` (≤4 breakpoints) — cuts input-token cost ~90% on hits
  across the loop. `cache_read`/`cache_creation` tokens are counted toward usage so
  the cost meter stays accurate (relevant to the metering note below).

## Billing options (pricing NOT yet decided)

Anthropic won't do passthrough billing, but we can meter + charge ourselves. The
data already exists: `cost_ledger` records `tokens_in`/`tokens_out`/`cost_usd`/
`model` per ticket + role + run; `getCostSummary` rolls it up; `cost_cap_monthly_usd`
guards spend; PAS already has Stripe.

Two viable models (not mutually exclusive):

1. **BYO key** (current): user's account/key pays, zero cost to us.
2. **We-run-it + metered**: run on our key, meter per token, charge via Stripe
   Billing Meters with a markup. Smoother UX (no Anthropic account needed); we
   carry the float + payment risk + are customer-of-record.

If we do metered billing, two things must harden first:
- **Accurate usage**: today `costUsd` is an *estimate* from a hardcoded `PRICING`
  table in the adapters — fine for a cap, **not** for invoicing. Pull real
  `usage.input_tokens`/`output_tokens` from each API response + current rates +
  margin, reconcile against the Anthropic invoice.
- **Spend control**: prepaid credits or a hard cap tied to a verified card (the
  `cost_cap` enforcement hook already exists).

Note: Agent Teams is *creator/build tooling*, arguably a separate product from the
consumer app-marketplace ($9/mo flat). Metered "compute to build your app" can
coexist with the flat marketplace sub. **This is an open pricing decision.**

## ToS

Selling *our product* (which uses the API, metered) is standard and allowed;
*reselling raw API access* is not. We're the former. Do a one-time read of
Anthropic's commercial terms before charging users.
