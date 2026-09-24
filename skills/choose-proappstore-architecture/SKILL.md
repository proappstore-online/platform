---
name: choose-proappstore-architecture
description: Choose the architecture and platform services for a ProAppStore app from its requirements — map each need (data, tenancy, realtime, files, identity and roles, external APIs, AI, maps, notifications, email/SMS/webhooks, monetisation, monitoring, UI shell, MCP, background work) to the existing platform primitive, name what the platform does not support, explain the trade-offs, and produce a bounded architecture decision that cites the Recommended Application Standard. Use when a user asks which ProAppStore service to use, how to design or structure a ProAppStore (PAS) app, whether to use D1, KV, storage, counters or rooms, or how to choose platform services and architecture for an app on proappstore.online. Not for creating, provisioning, deploying or auditing an app.
license: MIT
compatibility: Works with any Agent Skills client. Best with the ProAppStore MCP server (https://mcp.proappstore.online/mcp) for verifying SDK surfaces and reading an existing app; otherwise uses the public docs only. Read-only — no provisioning, no credentials.
metadata:
  author: proappstore-online
  version: "1.0"
  mcp-endpoint: https://mcp.proappstore.online/mcp
  standard-version: "1.5"
  issue: proappstore-online/platform#171
  triggers: choose, architecture, platform services, which ProAppStore service, structure a ProAppStore, D1, KV, storage, counters, rooms
allowed-tools: whoami sdk_reference recipe platform_guide list_templates app_info list_app_tools schema_status
---

# Choose ProAppStore architecture and platform services

You turn an app's requirements into a **bounded architecture decision**: which
existing platform primitive serves each need, which needs the platform does
not serve today, and what the trade-offs are — with every recommendation
cited to the current docs and the Recommended Application Standard. You do
not create, provision, deploy or audit anything; hand those off.

## When to use / when not to

- **Use** for "which service should I use for X?", "how should I structure a
  ProAppStore app that…", "D1 or KV?", "can the platform do realtime / files /
  background jobs?", and for reviewing an existing app's service choices.
- **Do not use** to create the app (hand off to `create-proappstore-app`), to
  audit against the standard, to write migrations or actions, or for apps that
  are not on ProAppStore.

## Rules

1. **Prefer the platform primitive.** If a need maps to a row in the
   [decision tables](references/decision-tables.md), recommend that primitive
   and cite its clause. A substitute (Firebase, Supabase, Stripe, Pusher, an
   own Worker) is recommended only when the tables say the need is
   unsupported, and then as a *flagged gap*, never as the default.
2. **Never fabricate APIs.** Name only SDK surfaces that exist: the modules
   `app.auth`, `app.actions`, `app.db` (and `app.db.tenant()`), `app.kv`,
   `app.counters`, `app.storage`, `app.rooms`, `app.roles`, `app.invites`,
   `app.proxy`, `app.ai`, `app.maps`, `app.notifications`, `app.email`,
   `app.sms`, `app.webhooks`, `app.subscription`, `app.license`,
   `app.usage`, `app.logs`, `app.tokens`. Before citing a method, check it with
   `sdk_reference` (feature: `auth`, `kv`, `counters`, `rooms`, `proxy`,
   `db`, `storage`, `maps`, `ai`, `notifications`, `sms`, `subscription`,
   `tenant`, `hooks`, `ui`, `recipes`, `design_system`) or `recipe`. If a
   surface is not there, say so — do not invent one.
3. **Name the unsupported honestly.** Scheduled/background execution, trusted
   server-side app code, server-authoritative realtime state, app-owned
   Workers, per-app pricing, third-party identity and external databases are
   not platform features today; see
   [unsupported requirements](references/unsupported-requirements.md) for the
   interim pattern and the tracking issue to cite.
4. **Bounded decision.** One recommendation per need, one paragraph of
   trade-off, one clause citation, one follow-up if any. No architecture the
   standard does not describe ([PAS-STACK-024](https://docs.proappstore.online/standard/stack/#pas-stack-024)).
5. **Read-only and credential-free.** This skill calls no mutating tool, and
   agents running it never handle credentials: it
   never handles tokens or `.env` files, and never runs `wrangler` or
   `gh repo create` — provisioning belongs to `create-proappstore-app`.
6. **Cite, don't restate.** Link the capability page and the clause; the
   standard's *Rationale* and *Recommended implementation* are the source.

## Workflow

### 1. Gather the requirements

Ask for what is missing; propose defaults from the description and confirm
the set. Product decisions are the user's — record them as blockers if open.

| Requirement | Why it matters |
|---|---|
| **Category and tenancy** — Tailored (one fork per customer) or Ready (shared, multi-tenant); who shares data with whom | decides row scoping and the tenancy clauses ([tailored vs ready](https://docs.proappstore.online/tailored-vs-ready/)) |
| **Data** — entities, relations, per-user vs per-project vs per-org, expected volume, search/export/stats | D1 via actions vs KV vs counters |
| **Files** — kinds, sizes, public or private | storage |
| **Realtime** — presence, chat, cursors, multiplayer; must state survive a reload or be authoritative? | rooms vs actions |
| **Identity and roles** — providers, who can do what, admin surface | platform auth + app roles |
| **External services** — APIs with keys, AI, maps, push, email/SMS, webhooks | proxy and the platform integrations |
| **Monetisation** — Pro features | platform subscription only |
| **Background work** — schedules, reapers, digests | unsupported today: interim pattern |
| **Mobile/PWA, monitoring, agents (MCP)** | UI shell, logs, registered actions |

For an **existing** app, read it first: `app_info` (URLs, template
provenance), `list_app_tools` (its registered actions), `schema_status`
(migrations). Do not guess what it already uses.

### 2. Map each need with the decision tables

Walk [references/decision-tables.md](references/decision-tables.md) row by
row. For every requirement record: primitive, clause id + URL, the
alternative you rejected and why. Check limits (KV 100 keys / 64 KB /
1 MB per user; rooms 32 peers, no per-app room cap, 4 KB messages, nothing persisted;
uploads 50 MB; proxy 10 000 requests/day) against the stated volume.

### 3. Identify unsupported requirements

Match against [references/unsupported-requirements.md](references/unsupported-requirements.md).
For each hit, state: what is unsupported, the interim pattern that stays
inside the standard, and the platform issue to cite. Never present a
substitute dependency as a solution.

### 4. Verify surfaces

For each recommended module, confirm the methods you will mention exist:
`sdk_reference` with the module's feature name, and `recipe` for a starting
pattern (real names: `crud-list`, `form-create`, `data-table`,
`search-filter`, `modal`, `tabs`, `icons`, `kv-preferences`,
`file-upload`, `realtime-chat`, `roles-rbac`, `ai-chat`, `map-embed`,
`maps-autocomplete`, `notifications`, `email-send`, `stripe-paywall`).
If the app will be created next, `list_templates` shows the approved scaffold
and its known deviations.

### 5. Produce the decision

Render [references/output-template.md](references/output-template.md): the
requirement → primitive table with citations, the trade-offs, the unsupported
list with interim patterns, the data-scoping sketch (which column ties every
row to a user or tenant — [PAS-DATA-007](https://docs.proappstore.online/standard/data/#pas-data-007)), and
the follow-ups. Keep it to one screen; put detail in the tables.

### 6. Hand off

- New app → `create-proappstore-app` with the chosen category/visibility/data needs.
- Schema and actions → the standard's [DATA chapter](https://docs.proappstore.online/standard/data/).
- Identity and roles → the [AUTH chapter](https://docs.proappstore.online/standard/auth/).
- A platform gap the user needs closed → cite the tracking issue; do not build around it.

## Blockers — hand back, do not work around

| Class | Signal | What to say |
|---|---|---|
| **Unsupported requirement** | a need with no primitive (scheduled work, trusted server code, authoritative realtime, own Worker, external DB, per-app pricing) | the interim pattern from the reference, and the issue to follow (#123, #148) |
| **Product decision** | tenancy model, visibility, monetisation, what is stored about people | ask; do not invent |
| **Verification** | `sdk_reference` does not show the method you wanted to cite | say the surface does not exist; recommend the closest real one |

## Reruns and failures

- **Rerun:** the skill is idempotent — the same requirements and the same
  docs produce the same decision, and nothing on the platform changes
  between runs. Rerun freely after a requirement changes.
- **Failure:** if a lookup (`sdk_reference`, `recipe`, `app_info`) fails, say
  so, mark that row of the decision *unverified* and stop rather than guess.

## Worked examples

[references/worked-examples.md](references/worked-examples.md) covers simple
CRUD, a multi-tenant app, realtime collaboration, a file-heavy app, and an app
that needs background work. [evals/cases.json](evals/cases.json) holds the
machine-checked expectations for the same five scenarios.
