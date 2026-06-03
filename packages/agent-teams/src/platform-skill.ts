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
- \`app.auth.signIn(provider?)\` — provider is ONLY \`'github'\` (default) or \`'google'\`.
  There is NO \`'apple'\` — \`signIn('apple')\` fails \`tsc\`. Adding Google is a ~one-line
  change (\`signIn('google')\`), NOT in-app OAuth.
- There is NO \`app.roles\` API — do RBAC in \`app.db\` (a roles table). \`app.roles.*\` fails \`tsc\`.
- \`app.auth.signInWithEmail(email)\` — magic-link email sign-in. Also \`app.auth.user\`, \`signOut()\`.
- CRITICAL — the user object (\`app.auth.user\`, or \`user\` from \`useProAuth\`) is EXACTLY
  \`{ id: string; login: string; avatarUrl: string | null; dateOfBirth: string | null }\`.
  There is NO \`name\` and NO \`email\` field. Use \`user.login\` for the display name and
  \`user.id\` (e.g. \`"gh:123"\`) as the stable key. Writing \`user.name\` or \`user.email\`
  (or \`user.name ?? user.email\`) FAILS \`tsc\` and breaks the deploy build.
- React: \`useProAuth(app)\`, \`useProGate(app)\`. UI: \`@proappstore/sdk/ui\` (SignInButton, ProfileMenu, GateScreen, …).
  (Only a provider NOT in that list would require custom in-app OAuth.)
- IMPORTANT — \`<SignInButton>\` props are ONLY \`{ app, label? }\`; it has NO \`provider\` prop and always calls \`app.auth.signIn()\` (GitHub). For a Google/Apple button, render your OWN button: \`<button onClick={() => app.auth.signIn('google')}>Sign in with Google</button>\`. Do NOT pass \`provider\`/\`onClick\`/etc. to \`<SignInButton>\` — that fails \`tsc\`. Confirm any component's exact props in node_modules/@proappstore/sdk before using it.

Free primitives (capped): \`app.kv\` (per-user key/value), realtime \`app.rooms\`
(WebSocket; peer/room caps), \`app.proxy.fetch(...)\` (call external APIs with the
user's keys from the vault — keys never touch client code).

Pro primitives (read_docs has exact return shapes — check before assuming fields):
- DB (per-app SQLite/D1): \`app.db.execute(sql, params?)\` → \`{ meta: { changes, duration, last_row_id } }\`
  (snake_case \`last_row_id\`, and NO \`.rows\`); \`app.db.query<T>(sql, params?)\` → \`{ rows: T[]; meta }\`
  (pass \`<T>\` or rows are \`unknown\`); \`app.db.batch(stmts)\`, \`app.db.migrate(migrations)\`, tenant scoping
  \`app.db.tenant(id).insert(table, row)\` / \`.findMany(table)\`.
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
 * Return the doc section(s) relevant to `topic`, or the whole doc (capped) when
 * no topic. Splits at ##/### headings (#### stays nested with its parent) and
 * returns every section whose heading OR body contains the topic — so a keyword
 * like "SignInButton" returns just the UI-components section, not the whole 600-
 * line guide. Progressive disclosure that's actually precise + cheap.
 */
// Default cap kept small (~1.5k tokens). The old 16k default re-injected the
// whole skills.md on every read_docs call across BA/Dev/QA — the single biggest
// cost driver in agent runs (a Dev turn hit ~300k input tokens). skills.md is
// largely ONE giant code block with no ##/### sub-headings, so heading-based
// slicing alone returned everything; the windowing fallback bounds it.
export function sliceDocs(text: string, topic?: string, max = 6000): string {
  if (!topic || !topic.trim()) return text.slice(0, max);
  const t = topic.toLowerCase();
  const lines = text.split('\n');

  // Split into chunks at level-2/3 headings (#### stays inside its ### parent).
  const chunks: string[] = [];
  let cur: string[] = [];
  for (const line of lines) {
    if (/^#{2,3}\s/.test(line) && cur.length) { chunks.push(cur.join('\n')); cur = []; }
    cur.push(line);
  }
  if (cur.length) chunks.push(cur.join('\n'));

  const matched = chunks.filter((c) => c.toLowerCase().includes(t));
  let out = matched.join('\n\n').trim() || text;
  if (out.length <= max) return out;

  // Still too big (e.g. the monolithic SDK code block matched) — return a window
  // centred on the first keyword hit so the agent gets the relevant lines, not
  // the entire document.
  const idx = Math.max(0, out.toLowerCase().indexOf(t));
  const start = Math.max(0, idx - Math.floor(max / 4));
  return out.slice(start, start + max);
}
