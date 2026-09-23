# Unsupported requirements — say so, give the interim pattern, cite the issue

A requirement in this list has **no platform primitive today**. The correct
recommendation is the interim pattern (which stays inside the standard) plus
the tracking issue — never a substitute dependency or an app-owned Worker.

| Requirement | Status | Interim pattern that conforms | Cite |
|---|---|---|---|
| Scheduled / background execution (reapers, digests, reminders, nightly jobs) | no cron for static apps | an idempotent, bounded, role-gated sweep action run from a privileged client (e.g. when a coach opens the page); document it in the README | [PAS-DATA-019](https://docs.proappstore.online/standard/data/#pas-data-019); platform issue #123 |
| Trusted server-side app code (verify a chess claim, run a rules engine, call an API inside a transaction) | no app-code execution surface; actions are SQL only | record the client's result as a *claim* and confirm it through a privileged action; express invariants in SQL where possible | [PAS-DATA-014](https://docs.proappstore.online/standard/data/#pas-data-014); platform issue #148 |
| Server-authoritative realtime state, persistent worlds, > 32 peers per room | rooms are ephemeral fan-out with untrusted payloads | rooms for presence/deltas + actions for the durable record; keep sessions small | [PAS-DATA-017](https://docs.proappstore.online/standard/data/#pas-data-017), [PAS-STACK-013](https://docs.proappstore.online/standard/stack/#pas-stack-013) |
| An app-owned Worker, Durable Object binding, queue or service binding | apps ship static assets; the platform runs the only Worker per app | model the behaviour as registered actions; file a platform request for the gap | [PAS-DATA-014](https://docs.proappstore.online/standard/data/#pas-data-014), [PAS-STACK-004](https://docs.proappstore.online/standard/stack/#pas-stack-004) |
| Per-app pricing, own checkout, in-app upgrade prompts | the store sells one platform subscription | `app.subscription` + the SDK gates; `app.license` for keys | [PAS-STACK-020](https://docs.proappstore.online/standard/stack/#pas-stack-020) |
| Third-party identity (Firebase Auth, Auth0, Clerk, own passwords) | platform identity only | `app.auth` providers; provisioned credential accounts for users without email | [PAS-STACK-006](https://docs.proappstore.online/standard/stack/#pas-stack-006), [PAS-AUTH-004](https://docs.proappstore.online/standard/auth/#pas-auth-004) |
| An external database or BaaS | one D1 per app via actions | model in `migrations.json` + actions | [PAS-STACK-007](https://docs.proappstore.online/standard/stack/#pas-stack-007) |
| Files over 50 MB, video transcoding, image pipelines | storage is plain object storage | chunk client-side, or keep large media external and store the reference | [PAS-STACK-012](https://docs.proappstore.online/standard/stack/#pas-stack-012) |
| High-volume email, SMS to end users | email is quota'd; SMS is creator-only | batch through `app.email` within quota; SMS only for creator-driven flows | [PAS-STACK-019](https://docs.proappstore.online/standard/stack/#pas-stack-019) |
| Self-service backups / point-in-time restore | none app-facing | export/import actions, soft deletes, a README recovery section | [PAS-OPS-014](https://docs.proappstore.online/standard/ops/#pas-ops-014) |
| Cross-app data sharing | one D1 per app; data workers are per app | the same registered actions over MCP, called by the other party with their own session | [PAS-DATA-016](https://docs.proappstore.online/standard/data/#pas-data-016) |
| Offline-first with conflict resolution | no sync engine | shell offline via the PWA config; writes only when online and idempotent | [PAS-UI-019](https://docs.proappstore.online/standard/ui/#pas-ui-019), [PAS-DATA-018](https://docs.proappstore.online/standard/data/#pas-data-018) |

When a gap is decisive for the product, say so plainly and stop: it is a
**blocker: unsupported requirement**, not a reason to design around the
standard.
