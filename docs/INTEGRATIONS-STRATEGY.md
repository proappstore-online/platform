# Third-Party Integrations Strategy

How the platform approaches external API integrations. Three tiers, one principle: devs never manage infrastructure credentials.

## Principle

Every third-party API call flows through the platform worker. The browser SDK never touches a secret. This gives us rate limiting, audit logging, credential rotation, and abuse prevention for free.

## Three Tiers

### Tier 1: Platform-managed

Platform owns the credentials. One account serves all apps. Devs call an SDK method, platform pays and rate-limits.

| Integration | Status | SDK method | Backed by |
|---|---|---|---|
| AI (text, chat, embeddings) | Live | `app.ai.generate/chat/embed` | Workers AI |
| Maps (geocode, route, reverse) | Live | `app.maps.geocode/route/reverseGeocode` | Nominatim + OSRM |
| Push notifications | Live | `app.notifications.subscribe/send/notifyUser` | Web Push + VAPID |
| SMS | Live | `app.sms.send/broadcast` | Twilio |
| Transactional email | Planned | `app.email.send` | Resend |
| Image processing | Planned | `app.images.resize/optimize` | Cloudflare Images |
| Full-text search | Planned | `app.search.index/query` | D1 FTS5 |

### Tier 2: User-key vault (proxy)

Dev or user brings their own API key. Platform stores it encrypted, injects it server-side. The browser never sees the key.

| Integration | How | Status |
|---|---|---|
| OpenAI / Anthropic / Google AI | User adds key in dashboard, `app.proxy.fetch('/openai/...')` | Live (proxy) |
| Google Maps / Mapbox | Dev adds key via console, platform injects | Via proxy |
| Stripe (per-app) | Dev adds key, `app.payments.*` | Planned |
| Any REST API | `app.proxy.fetch(url)` with dev's secrets from vault | Live |

The proxy already exists (`app.proxy.fetch`). The key vault already exists (`app.keys`). Any REST API in the world works through this pattern today.

### Tier 3: Webhooks (events out)

Platform fires HTTP POST on events. Devs configure webhook URLs per app in the console. Zapier, Make, n8n, and any HTTP endpoint work natively.

| Event | Payload | Use case |
|---|---|---|
| `user.signed_up` | `{ userId, appId, login, provider }` | CRM, welcome email |
| `user.deleted` | `{ userId, appId }` | Data cleanup |
| `subscription.created` | `{ userId, tier, priceId }` | Billing sync |
| `subscription.cancelled` | `{ userId, tier }` | Churn tracking |
| `role.assigned` | `{ userId, appId, role, grantedBy }` | Permission sync |
| `role.revoked` | `{ userId, appId, role }` | Permission sync |
| `app.provisioned` | `{ appId, creatorId }` | Deployment tracking |
| `notification.sent` | `{ appId, targetUserId, title }` | Analytics |
| `storage.uploaded` | `{ appId, userId, path, size }` | Media pipeline |

### Tier 0: Free libraries & APIs (no key, no proxy)

Many useful tools require no API key and no platform involvement. Apps should prefer these first. This list is shared with FAS (see `freeappstore.online/skills.md` for the full table).

**Client-side libraries:** Leaflet (maps), Recharts (charts), Tiptap (rich text), date-fns, react-markdown, react-pdf/jsPDF, qrcode.react, dnd-kit (drag & drop), Framer Motion (animations), Lucide React (icons), React Hook Form, Zustand (state).

**Free APIs:** Open-Meteo (weather), Nominatim (geocoding), OSRM (routing), ExchangeRate-API, REST Countries, Free Dictionary API, Hacker News (Algolia), Wikipedia, Open Library, randomuser.me, Lorem Picsum.

PAS apps have access to all of these plus the Tier 1 platform-managed services (AI, maps, push, SMS) that FAS doesn't have.

## What we don't build

- **Zapier/Make connectors.** Webhooks are the standard. Every automation platform accepts them. Custom connectors are a maintenance burden with no user-facing benefit over webhooks.
- **Per-provider AI SDK wrappers.** Workers AI is the platform-managed option. OpenAI/Anthropic/Google go through the proxy with user keys. No `app.openai.*` or `app.anthropic.*`.
- **Integration marketplace.** The proxy + vault pattern handles unlimited third-party APIs without us building provider-specific code.

## Implementation roadmap

### Phase 1: Email (Tier 1)
- New SDK module: `app.email.send(to, subject, body, opts)`
- Backend: `/v1/email/send` endpoint, Resend API
- Rate limit: 100/day per app (free), 1000/day (pro)
- Platform owns the Resend account + sending domain

### Phase 2: Webhooks (Tier 3)
- New D1 table: `app_webhooks (app_id, event, url, secret, active)`
- Console UI: webhook configuration per app (URL, events to subscribe, test button)
- Backend: webhook dispatcher (fire-and-forget, retry on 5xx, dead-letter after 3 failures)
- SDK: `app.webhooks.configure(event, url)` for programmatic setup
- Shared HMAC secret per webhook for verification

### Phase 3: Search (Tier 1)
- Enable D1 FTS5 on per-app databases
- SDK: `app.search.index(table, columns)`, `app.search.query(q)`
- Zero external service, uses SQLite's built-in full-text search

### Phase 4: Images (Tier 1)
- SDK: `app.images.resize(path, { width, height, format })`
- Backend: Cloudflare Images or on-the-fly transform via Workers
- Integrates with existing `app.storage` paths

### Phase 5: Per-app Payments (Tier 2)
- SDK: `app.payments.createCheckout(opts)`, `app.payments.listCharges()`
- Dev adds their own Stripe key via console (not the platform's Stripe)
- Platform proxies Stripe API with dev's key from vault
- Distinct from `app.subscription` (platform-level Pro subscription)
