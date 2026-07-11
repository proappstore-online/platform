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

Apps are built on \`@proappstore/sdk\` (self-contained — do NOT import \`@freeappstore/sdk\`). One instance:
\`import { initPro } from '@proappstore/sdk'; const app = initPro({ appId })\`.
Stack: React + TypeScript + Vite + Tailwind, deployed on Cloudflare. For exact
method signatures, read the installed package's .d.ts under node_modules.

Identity (free, platform-provided — the platform runs the OAuth; no client secret in the app):
- \`app.auth.signIn(provider?)\` — provider is ONLY \`'github'\` (default) or \`'google'\`.
  There is NO \`'apple'\` — \`signIn('apple')\` fails \`tsc\`. Adding Google is a ~one-line
  change (\`signIn('google')\`), NOT in-app OAuth.
- RBAC is a BUILT-IN PLATFORM FEATURE — use \`app.roles\` for any permission/gating
  need (admins, moderators, owner-only screens, member vs viewer). Do NOT roll your
  own roles table or hardcode user ids. API: \`assign(userId, role)\`,
  \`revoke(userId, role)\`, \`check(role)\` → boolean, \`myRoles()\` → string[],
  \`listAll()\` (owner-only). Default roles: owner/member/moderator/editor/viewer;
  custom roles = pass any string. \`owner\` is auto-assigned to the app creator.
- \`app.auth.signInWithEmail(email)\` — magic-link email sign-in. Also \`app.auth.user\`, \`signOut()\`.
- CREDENTIAL ACCOUNTS (username + password, NO email/OAuth) — for kids/students who
  have no email (e.g. a classroom). An adult signed in as a creator calls
  \`await app.auth.provisionChild({ displayName?, login?, isChild? })\` → returns
  \`{ uid, login, password }\` ONCE (show it to the adult immediately — the password is
  never retrievable again; if lost, re-provision). The child then signs in with
  \`await app.auth.signInWithCredentials(login, password)\`, which mints a normal PAS
  session — \`app.db\`/\`app.rooms\`/\`app.roles\` all work unchanged. Do NOT build your own
  username/password table — minting a usable session needs the platform signing key.
  Provisioning is adult-gated; there is NO public password self-signup.
- The user object (\`app.auth.user\`, or \`user\` from \`useProAuth\`) is
  \`{ id: string; name: string; login: string; avatarUrl: string | null; dateOfBirth: string | null }\`.
  Use \`user.name\` for display and \`user.id\` (e.g. \`"gh:123"\`) as the stable key.
  There is NO \`email\` field.
- Everything — hooks, components, \`initPro\`, types — imports from \`'@proappstore/sdk'\`:
  \`import { initPro, useProAuth, ProShell, Avatar } from '@proappstore/sdk'\`.
  Subpath imports (\`@proappstore/sdk/hooks\`, \`@proappstore/sdk/ui\`) also work but are not required.
- ProShell can wrap your entire app — handles auth gate, subscription gate, provider context, topbar, avatar menu, theme:
  \`<ProShell app={app} appName="My App" menuItems={[{label:'Profile', onClick}]}>{children}</ProShell>\`.
- If the app needs its own primary navigation, do NOT stack a second navbar under ProShell. Use
  \`renderTopbar={({ profileMenu, textSizeToggle }) => <YourNav>{textSizeToggle}{profileMenu}</YourNav>}\`,
  or \`hideTopbar hideFooter\` and compose SDK primitives directly.
- \`<SignInButton>\` props are \`{ app, label?, provider? }\`, where provider is \`'github'\` (default) or \`'google'\`.

Free primitives (capped): \`app.kv\` (per-user key/value), realtime \`app.rooms\`
(WebSocket; peer/room caps), \`app.proxy.fetch(...)\` (call external APIs with the
user's keys from the vault — keys never touch client code).

Pro primitives (read_docs has exact return shapes — check before assuming fields):
- App actions (REQUIRED for user-facing app data — raw \`app.db\` SQL is restricted to the app's
  team, so regular users get 403 on it): define operations in root \`mcp.json\` and call
  \`app.actions.call<T>(name, params?)\`. PAS authenticates the user, enforces declared role metadata,
  injects \`:__user_id\`/\`:__now\`/\`:__uuid\`, and executes prepared SQL through the app data worker.
  - The tool SQL IS the security boundary — every action is directly callable by any signed-in
    user. Scope self-writes with \`user_id = :__user_id\`; guard privileged writes with an EXISTS
    subquery on the app's own role table checking \`:__user_id\`; derive granted privileges from
    server rows (INSERT...SELECT FROM the grant row), never from client params. One-shot grant
    guards (e.g. "has an accepted invite") must be consumed/revoked, or they replay forever.
  - Multi-step flows that must not be observable half-applied use \`"operation": "batch"\` with
    \`"statements": [...]\` (max 25, one shared params pool) — executed as ONE atomic D1 transaction.
  - Registration warns on write statements with no \`:__user_id\` — treat warnings as bugs unless
    the statement is deliberately unscoped (e.g. consuming an unguessable one-time code).
  - Registration also COMPILES each action against the live schema (#33): an action that
    references a table/column not in \`migrations.json\` FAILS the deploy, naming the tool + column.
    So keep \`migrations.json\` and \`mcp.json\` in lockstep — every column an action reads/writes
    must be created by a migration.
- DB (per-app SQLite/D1, migrations + team-only tooling — NOT for user-facing reads/writes):
  \`app.db.execute(sql, params?)\` → \`{ meta: { changes, duration, last_row_id } }\`
  (snake_case \`last_row_id\`, and NO \`.rows\`); \`app.db.query<T>(sql, params?)\` → \`{ rows: T[]; meta }\`
  (pass \`<T>\` or rows are \`unknown\`); \`app.db.batch(stmts)\`, tenant scoping
  \`app.db.tenant(id).insert(table, row)\` / \`.findMany(table)\`.
  - SCHEMA lives in \`migrations.json\` at the repo root — this is CANONICAL and REQUIRED whenever
    the app has a database. The deploy applies it to D1 BEFORE the frontend goes live and BEFORE
    mcp.json actions register, so an action can never reference a column that isn't there yet
    (the drift that 500'd users). Every column your mcp.json actions read/write MUST exist in
    migrations.json. Shape: \`{ "migrations": [ { "name": "0001_init", "sql": "CREATE TABLE ..." } ] }\`
    — \`name\`+\`sql\` are the ONLY fields (no \`id\`/\`version\`/\`up\`/\`down\`). Each runs once, in array
    order, idempotent.
    - ADDITIVE ONLY (enforced — a violating deploy FAILS): \`CREATE TABLE/INDEX\`, \`ALTER TABLE … ADD
      COLUMN\`, \`INSERT\`. \`DROP\`/\`RENAME\`/\`DELETE\`/\`UPDATE\` are rejected. Evolve by adding; keep new
      columns nullable/defaulted so old rows and old code stay valid. NEVER edit an applied
      migration — add a new one (\`0002_…\`).
    Example migrations.json: \`{ "migrations": [ { "name": "0001_init", "sql": "CREATE TABLE events (id TEXT PRIMARY KEY, user_id TEXT, title TEXT, created_at INTEGER)" }, { "name": "0002_photos", "sql": "ALTER TABLE events ADD COLUMN photo_url TEXT" } ] }\`.
  - \`app.db.migrate(migrations)\` — same \`{ name, sql }[]\` shape; mirrors migrations.json for local
    iteration, but migrations.json is authoritative (it runs on every deploy, before dependent code).
- Storage (R2): \`app.storage.upload(path, data, contentType?)\`, \`app.storage.download(path)\`.
- Server AI: \`app.ai.generate(prompt, opts?)\`, \`app.ai.chat(messages, opts?)\`, \`app.ai.embed(text, opts?)\`.
- Subscriptions/payments: \`app.subscription.status()\`, \`openCheckout(req)\`, \`openPortal(url)\`; \`app.license.current()\`, \`validate(key)\`.
- Messaging: \`app.email\`, \`app.sms.send(to, msg)\` / \`broadcast(nums, msg)\`, \`app.notifications.subscribe(swPath?)\` (web push).
- Other: \`app.maps\` (geocode/route), \`app.webhooks.list()\`/\`register(event, url)\`/\`remove(id)\`, \`app.usage\` (telemetry, auto-started).

Design system (CSS classes in src/index.css):
- Colors: var(--paper), var(--ink), var(--muted), var(--accent), var(--line), var(--panel), var(--error), var(--success)
- Layout: \`.card\` (bordered panel), \`.empty-state\` (centered message)
- Buttons: \`.btn .btn-primary\` (accent filled), \`.btn .btn-secondary\` (outlined), \`.btn .btn-ghost\` (transparent)
- Forms: \`.input\` (styled input/select with focus ring)
- Tags: \`.badge .badge-accent\`, \`.badge-success\`, \`.badge-error\` (pill tags)
- Fonts: \`.display-font\` (Fraunces serif headings), body is Manrope
- Dark mode: automatic via CSS custom properties

SDK UI components (\`import { ... } from '@proappstore/sdk/ui'\`):
- Avatar, ThemeToggle, TextSizeToggle, ProfileMenu, ProProfilePage
- SignInButton supports \`provider="github"\` and \`provider="google"\`; hooks expose default GitHub sign-in
- GateScreen, ProBadge, SubscriptionStatus, UpgradeCard, BillingButton
- UI docs: https://docs.proappstore.online/ui/
Official docs (the SAME references users read — cite these links so the founder can learn the API):
- Platform/SDK guide: https://proappstore.online/skills.md  (use the read_docs tool to read it live)
- Docs site: https://docs.proappstore.online/  · API base: https://api.proappstore.online
When you explain a capability, include the relevant doc link so the founder can read more.

Rules:
- Free apps must be MIT; Pro unlocks DB/storage/server-AI/custom-domain/cron/uncapped-rooms.
- If a capability isn't listed here and you can't confirm it in the code, the installed SDK types, or the live docs (read_docs), it may not exist — say so, don't fabricate it.`;

/** Canonical, user-facing docs the agents should read + cite. */
export const DOCS_SKILLS_URL = 'https://proappstore.online/skills.md';
export const DOCS_SITE_URL = 'https://docs.proappstore.online/';

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
