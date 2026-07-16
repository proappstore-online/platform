# @proappstore/backend

Cloudflare Worker API for ProAppStore at `api.proappstore.online`.

Handles Stripe webhooks, subscriptions, license keys, app/listing CRUD, analytics, custom domains, push notifications, email, SMS, AI inference, storage, and provisioning.

## Infrastructure

| Resource | Value |
|----------|-------|
| Worker | `proappstore-api` |
| Route | `api.proappstore.online/*` |
| D1 | `pas` (`585bbda3-0016-42ad-a53d-c089f1864fcb`) |
| R2 | `pas-storage` |
| Workers AI | Bound as `env.AI` |

## Routes

| File | Endpoints | Description |
|------|-----------|-------------|
| `auth.ts` | GitHub OAuth (login, callback, me, logout) | Session management |
| `subscription.ts` | Stripe checkout, billing portal, status | $5/mo platform subscription |
| `webhook.ts` | `POST /webhook` | Stripe webhook handler |
| `license.ts` | License key CRUD + validation | Per-app license keys |
| `apps.ts` | App CRUD | Create, list, update apps |
| `listings.ts` | Listing CRUD + validation + assets | Storefront entries |
| `provision.ts` | `POST /v1/publish` | Full provision: GitHub repo + CF Pages + DNS + registry |
| `domains.ts` | Custom domain management | BYO domain for pro apps |
| `analytics.ts` | Analytics config + stats | Per-app analytics |
| `storage.ts` | File upload/download | R2 storage per app |
| `notifications.ts` | Web push subscribe/broadcast | Push notifications |
| `email.ts` | Transactional email | Via Resend |
| `sms.ts` | SMS messages | Via Twilio |
| `ai.ts` | LLM + embeddings | Workers AI inference |
| `keys.ts` | User API key vault | AES-256-GCM encrypted |
| `secrets.ts` | App secrets + proxy | Secret-injecting API proxy |
| `maps.ts` | Geocoding, routing | OSM/Nominatim/OSRM |
| `logs.ts` | Client log ingestion + query | 3-layer logging |
| `webhooks-config.ts` | Outbound webhook CRUD | HMAC-SHA256 signed |
| `usage.ts` | Usage tracking | Heartbeat telemetry for payout splits |
| `payouts.ts` | Creator payouts | Usage-based revenue splits |
| `submissions.ts` | App submission review | Approval/rejection flow |
| `connect.ts` | Stripe Connect | Creator payment accounts |
| `services.ts` | Services marketplace | Consultant listings |
| `tools.ts` | MCP tool registry | Per-app tool manifests |
| `engagements.ts` | Engagement tracking | User interaction metrics |
| `kv.ts` | Per-user key-value store | `app.kv` SDK primitive |
| `counters.ts` | Shared atomic counters | `app.counters` SDK primitive |
| `rooms.ts` | Real-time WebSocket rooms | `app.rooms` SDK primitive |
| `roles.ts` | App-level roles + permissions | `app.roles` SDK primitive |
| `invites.ts` | App invites (create/list/revoke/redeem) | Link + QR invites |
| `qa.ts` | QA flows + runs + artifacts | `POST/GET /v1/apps/:appId/qa/runs`, `/qa/keys` |

## Dev

```bash
pnpm dev       # wrangler dev
pnpm deploy    # wrangler deploy
pnpm typecheck # tsc --noEmit
```
