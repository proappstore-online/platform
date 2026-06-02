/**
 * PAS platform/SDK capabilities — the "ground truth" reference injected into
 * every agent's system prompt (cached, so it's cheap across the loop). This is
 * the always-on *index* tier of progressive disclosure: enough for agents to use
 * real APIs and answer "can we do X?" without inventing platform behavior.
 *
 * Keep it concise and ACCURATE — it's derived from packages/sdk/src. For exact
 * signatures the Dev should read the installed types under
 * node_modules/@proappstore/sdk (and its @freeappstore/sdk base).
 */
export const PLATFORM_CAPABILITIES = `## PAS platform & SDK — ground truth (use these real APIs; do NOT invent platform features)

Apps are built on \`@proappstore/sdk\` (extends \`@freeappstore/sdk\`). One instance:
\`import { initPro } from '@proappstore/sdk'; const app = initPro({ appId })\`.
Stack: React + TypeScript + Vite + Tailwind, deployed on Cloudflare. For exact
method signatures, read the installed package's .d.ts under node_modules.

Identity (free, platform-provided — apps do NOT choose the provider in their own
code, and there is no per-app "enable Google/SSO" toggle):
- \`app.auth\` → \`user\`, \`signIn()\`, \`signOut()\`. React: \`useProAuth(app)\`, \`useProGate(app)\`.
- UI components: \`@proappstore/sdk/ui\` (SignInButton, ProfileMenu, GateScreen, …).
  A different sign-in (e.g. a Google button) = implement that OAuth IN the app; not a platform setting.

Free primitives (capped): \`app.kv\` (per-user key/value), realtime \`app.rooms\`
(WebSocket; peer/room caps), \`app.proxy.fetch(...)\` (call external APIs with the
user's keys from the vault — keys never touch client code).

Pro primitives:
- DB (per-app SQLite/D1): \`app.db.execute(sql, params?)\`, \`app.db.batch(stmts)\`,
  \`app.db.migrate(migrations)\`, and tenant scoping \`app.db.tenant(id).insert(table, row)\` / \`.findMany(table)\`.
- Storage (R2): \`app.storage.upload(path, data, contentType?)\`, \`app.storage.download(path)\`.
- Server AI: \`app.ai.generate(prompt, opts?)\`, \`app.ai.chat(messages, opts?)\`, \`app.ai.embed(text, opts?)\`.
- Subscriptions/payments: \`app.subscription.status()\`, \`openCheckout(req)\`, \`openPortal(url)\`; \`app.license.current()\`, \`validate(key)\`.
- Messaging: \`app.email\`, \`app.sms.send(to, msg)\` / \`broadcast(nums, msg)\`, \`app.notifications.subscribe(swPath?)\` (web push).
- Other: \`app.maps\` (geocode/route), \`app.webhooks.list()\`/\`register(event, url)\`/\`remove(id)\`, \`app.usage\` (telemetry, auto-started).

Rules:
- Free apps must be MIT; Pro unlocks DB/storage/server-AI/custom-domain/cron/uncapped-rooms.
- If a capability isn't listed here and you can't confirm it in the code or the installed SDK types, it may not exist — say so, don't fabricate it.`;
