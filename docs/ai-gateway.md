# AI Gateway (Agent Teams)

Every LLM call Agent Teams makes goes through Cloudflare AI Gateway when the
gateway is configured, and straight to the provider otherwise (#22). The
gateway adds per-request token and cost analytics, caching, rate limiting and
provider-side fallback without touching what the platform sends: the owner's
BYO key passes through unchanged and Anthropic prompt caching is preserved.

## What is routed

| Call | Module | Provider | Route |
|---|---|---|---|
| BA / Dev / QA build runs (`cf-native`) | `runtimes/cf-native.ts` | Anthropic | `${gateway}/anthropic/v1/messages` |
| BA / Dev / QA build runs (`openai-responses`) | `runtimes/openai-responses.ts` | OpenAI | `${gateway}/openai/responses` |
| PO chat | `po-chat.ts` | Anthropic | shared helper `fetchAnthropicMessages` |
| Architect (Knowledge Base) chat | `architect-chat.ts` | Anthropic | shared helper |
| QA (test thread) chat | `qa-chat.ts` | Anthropic | shared helper |
| Listing generator | `project-do.ts` | Anthropic | shared helper |

There is no other outbound model call in the worker: a test pins that no
source file names a provider host outside `runtimes/ai-gateway.ts`.

## Configuration (`packages/agent-teams`)

| Name | Kind | Meaning |
|---|---|---|
| `AI_GATEWAY_ACCOUNT_ID` | var | Cloudflare account id. |
| `AI_GATEWAY_ID` | var | The gateway's id (`pas-agent-teams`). Routing is **on only when both vars are set**; unset = direct provider calls, nothing else changes. |
| `AI_GATEWAY_TOKEN` | secret | For an *authenticated* gateway: sent as `cf-aig-authorization: Bearer …` — to the gateway only, never to a provider. `wrangler secret put AI_GATEWAY_TOKEN` on `proappstore-agent-teams`. |
| `AI_GATEWAY_STRICT` | var, optional | `"1"` forbids the direct fallback below. |

Auth headers, exactly: the BYO key goes to whichever host answers (`x-api-key`
for Anthropic, `Authorization: Bearer` for OpenAI); the gateway token goes to
the gateway host only. Neither is ever logged — error messages carry the
provider's `error.message` field and the status, never a request body.

## Fallback

A gateway *outage* is a failure that means the gateway did not relay the
request: a network error, or an edge status — 502 / 503 / 504 / 52x. On an
outage the call is retried once against the provider's direct API, without the
gateway token, and the worker logs `[ai-gateway] gateway unreachable (…);
switching this run to <provider> directly`. For a build run the rest of that
run stays direct (its retry loop keeps the switched base URL); the next run
resolves the gateway again.

What is **not** an outage and never falls back: any provider answer the
gateway relayed — 400, 401/403 (bad BYO key or gateway token; the message says
which side), 429 (rate limit), or a provider 500. A 401 via the gateway is
reported as "via AI Gateway — check your key, or the gateway token".

`AI_GATEWAY_STRICT = "1"` turns the fallback off: an outage is then surfaced
as the error the caller would have seen (`AI Gateway unreachable (503); strict
routing forbids the direct fallback`), and the run parks in `needs-input` the
way any provider error does. Use it when every call must be observable at the
gateway, at the cost of availability during a gateway incident.

## Cost accounting: tables are the estimate, the gateway is the record

The cost meter (per-turn heartbeats, the monthly cap, `cost_ledger`) is
computed from provider token counts times hand-maintained price tables in
`runtimes/pricing.ts` (`ANTHROPIC_PRICING`, `OPENAI_PRICING`,
`PRICING_VERIFIED_AT`). Those tables go stale on every provider reprice, so:

- **The gateway is the source of truth for money.** Dashboard → AI → AI
  Gateway → `pas-agent-teams` → Logs shows tokens and cost per request;
  Analytics aggregates them. The payout model (#24 / #25) should read the
  gateway's numbers, not `cost_ledger`.
- **Monthly cross-check** (ops): compare the gateway's cost for the month with
  `SELECT SUM(cost_usd) FROM cost_ledger` across projects (or the per-project
  `cost/detail` route). A drift above ~10 % means a table is stale: update
  `pricing.ts`, bump `PRICING_VERIFIED_AT`, and note the drift in the runbook.
- **Unknown models never price silently.** `priceFor()` meters an unlisted
  model at the provider's fallback rate and warns once per model in the Worker
  logs (`[pricing] no price for … — add it to runtimes/pricing.ts`). A test
  pins that every model the platform configures by default is in the tables.

## Verifying routing after a deploy

1. POST the gateway's Anthropic endpoint with a throwaway key:

   ```bash
   curl -X POST https://gateway.ai.cloudflare.com/v1/<account>/pas-agent-teams/anthropic/v1/messages \
     -H "x-api-key: sk-ant-throwaway" -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \
     -d '{"model":"claude-haiku-4-5","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}'
   ```

   Expect an Anthropic 401 (the gateway forwarded the request) and a row in the
   gateway's Logs. With an authenticated gateway, omitting `cf-aig-authorization`
   yields the gateway's own 401 instead.
2. Run one PO chat turn on any project; the same request appears in the Logs
   with the project's model and token counts.
3. `wrangler tail proappstore-agent-teams` during a run should show no
   `[ai-gateway] gateway unreachable` lines. If it does, the gateway is down and
   runs are going direct (or, under strict routing, failing).

## Tests

`runtimes/ai-gateway.test.ts` (routing, headers, outage classification, the
shared Anthropic helper's fallback and strict mode, and the source scan),
`runtimes/cf-native.test.ts` (prepare → run hits the gateway URL, forwards the
gateway token, keeps the BYO key; a gateway outage mid-run switches to direct
without the token), `runtimes/pricing.test.ts` (default models are priced;
unknown models warn once), and `project-do-gateway.test.ts` (the PO chat end
to end over the DO: gateway URL and headers, then the fallback).
