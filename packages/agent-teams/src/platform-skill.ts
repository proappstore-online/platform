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

Identity (free, platform-provided — the platform runs the OAuth; no client secret in the app):
- \`app.auth.signIn(provider?)\` — provider is \`'github'\` (default), \`'google'\`, or \`'apple'\`.
  So switching to or adding Google/Apple is a ~one-line change (e.g. \`signIn('google')\`), NOT in-app OAuth.
- \`app.auth.signInWithEmail(email)\` — magic-link email sign-in. Also \`app.auth.user\`, \`signOut()\`.
- React: \`useProAuth(app)\`, \`useProGate(app)\`. UI: \`@proappstore/sdk/ui\` (SignInButton, ProfileMenu, GateScreen, …).
  (Only a provider NOT in that list would require custom in-app OAuth.)

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

Official docs (the SAME references users read — cite these links so the founder can learn the API):
- Platform/SDK guide: https://proappstore.online/skills.md  (use the read_docs tool to read it live)
- Docs site: https://proappstore.online/docs  · API base: https://api.proappstore.online
When you explain a capability, include the relevant doc link so the founder can read more.

Rules:
- Free apps must be MIT; Pro unlocks DB/storage/server-AI/custom-domain/cron/uncapped-rooms.
- If a capability isn't listed here and you can't confirm it in the code, the installed SDK types, or the live docs (read_docs), it may not exist — say so, don't fabricate it.`;

/** Canonical, user-facing docs the agents should read + cite. */
export const DOCS_SKILLS_URL = 'https://proappstore.online/skills.md';
export const DOCS_SITE_URL = 'https://proappstore.online/docs';

/**
 * Return the doc section(s) whose heading matches `topic` (markdown ##–####),
 * or the whole doc (capped) when no topic. Lets read_docs do progressive
 * disclosure instead of dumping the full 600-line guide every call.
 */
export function sliceDocs(text: string, topic?: string, max = 16000): string {
  if (!topic || !topic.trim()) return text.slice(0, max);
  const t = topic.toLowerCase();
  const lines = text.split('\n');
  const out: string[] = [];
  let capturing = false;
  let captureLevel = 0;
  for (const line of lines) {
    const h = /^(#{2,4})\s+(.*)/.exec(line);
    if (h) {
      const level = h[1]!.length;
      if (capturing && level <= captureLevel) capturing = false;
      if (!capturing && h[2]!.toLowerCase().includes(t)) { capturing = true; captureLevel = level; }
    }
    if (capturing) out.push(line);
  }
  const section = out.join('\n').trim();
  return (section || text).slice(0, max);
}
