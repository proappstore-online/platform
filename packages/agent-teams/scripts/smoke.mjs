#!/usr/bin/env node
/**
 * End-to-end smoke harness for the Agent Teams loop — drives the REAL API the way
 * the console does, and asserts each stage. This is how we prove the loop without
 * the UI (the thing that's been impossible to verify otherwise).
 *
 * Usage:
 *   SESSION_TOKEN=<pas session token> node packages/agent-teams/scripts/smoke.mjs [slug] [--full]
 *
 * Default run (cheap, ~$0.30, NO deploy): reset → Build KB → assert KNOWLEDGE.md
 * + docs written → chat the PO → assert it files a multi-ticket backlog. This
 * exercises exactly the stages we keep fixing (KB write, PO backlog), spends one
 * Architect + one PO run, and creates NO CF Pages project (reuses a fixed slug).
 *
 * --full also: press Play → poll the first ticket to done/failed → check the app
 * is live + E2E results published. Expensive (real build/deploy, more $$, burns a
 * CF Pages slot), so opt-in.
 *
 * Prereqs: the token's user must have a BYO Anthropic key in the vault (the agents
 * need it) — otherwise the Architect/PO runs fail and KB/backlog never appear.
 */

const AGENT_BASE = process.env.AGENT_BASE || 'https://agents.proappstore.online';
const KB_BASE = process.env.KB_BASE || 'https://kb.proappstore.online';
const TOKEN = process.env.SESSION_TOKEN;
const args = process.argv.slice(2);
const FULL = args.includes('--full');
const SLUG = (args.find((a) => !a.startsWith('--')) || 'smoke-loop').toLowerCase();

if (!TOKEN) { console.error('SESSION_TOKEN env var is required (a PAS session token).'); process.exit(2); }

const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
let passed = 0, failed = 0;

const log = (s) => console.log(s);
const ok = (s) => { passed++; console.log(`  \x1b[32m✓\x1b[0m ${s}`); };
const bad = (s) => { failed++; console.log(`  \x1b[31m✗ ${s}\x1b[0m`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, init = {}) {
  const res = await fetch(`${AGENT_BASE}${path}`, { ...init, headers: { ...H, ...(init.headers || {}) } });
  const text = await res.text();
  let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  return { status: res.status, ok: res.ok, body };
}

/** Poll `fn` until it returns truthy or the timeout elapses. */
async function until(label, fn, { timeoutMs, everyMs = 5000 }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= deadline) return null;
    process.stdout.write('.');
    await sleep(everyMs);
  }
}

async function main() {
  log(`\nAgent Teams smoke — slug "${SLUG}" @ ${AGENT_BASE}${FULL ? ' (FULL: build+deploy)' : ' (KB+backlog only)'}\n`);

  // 0) Health
  const health = await api('/health');
  health.ok ? ok(`/health (${health.body.version ?? '?'})`) : bad(`/health → ${health.status}`);

  // 1) Create (idempotent for a fixed slug — no new repo/Pages on re-run)
  const idea = 'A tiny single-page counter: one button increments a number persisted per-user via app.kv, shown big and centered. No auth gating beyond the platform default.';
  const create = await api('/v1/projects', { method: 'POST', body: JSON.stringify({ name: 'Smoke Loop', slug: SLUG, idea }) });
  create.ok ? ok(`project ready (${SLUG})`) : bad(`create → ${create.status}: ${JSON.stringify(create.body)}`);
  if (!create.ok) return finish();

  // 2) Reset prior state so the run is clean + repeatable
  const tix = await api(`/v1/projects/${SLUG}/tickets`);
  for (const t of (tix.body.tickets || [])) await api(`/v1/projects/${SLUG}/tickets/${t.id}`, { method: 'DELETE' });
  for (const thread of ['build', 'research']) await api(`/v1/projects/${SLUG}/chat/history?thread=${thread}`, { method: 'DELETE' });
  ok('reset tickets + chat');

  // 3) Build KB → wait for the Architect to write KNOWLEDGE.md + docs/
  const research = await api(`/v1/projects/${SLUG}/research`, { method: 'POST' });
  research.ok ? ok('Build KB dispatched') : bad(`/research → ${research.status}: ${JSON.stringify(research.body)}`);
  log('  waiting for the Architect to write the KB (≤4m)…');
  const kb = await until('kb', async () => {
    const f = await api(`/v1/projects/${SLUG}/files`);
    const files = (f.body.files || []).map((x) => x.path);
    return files.includes('KNOWLEDGE.md') ? files : null;
  }, { timeoutMs: 240_000 });
  process.stdout.write('\n');
  if (kb) {
    ok(`KNOWLEDGE.md written`);
    const docs = kb.filter((p) => /^docs\/.+\.md$/i.test(p));
    docs.length ? ok(`${docs.length} docs/ file(s): ${docs.join(', ')}`) : bad('no docs/*.md written');
  } else {
    bad('KNOWLEDGE.md never appeared (Architect stuck? no BYO Anthropic key?)');
  }

  // 4) Chat the PO → it should file a MULTI-ticket backlog (not just one)
  const chat = await api(`/v1/projects/${SLUG}/chat`, {
    method: 'POST',
    body: JSON.stringify({ thread: 'build', message: 'Build the counter app end to end: scaffold + the counter UI + persistence. Break it into the right tickets.' }),
  });
  chat.ok ? ok('PO chat sent') : bad(`/chat → ${chat.status}: ${JSON.stringify(chat.body)}`);
  await sleep(3000);
  const after = await api(`/v1/projects/${SLUG}/tickets`);
  const count = (after.body.tickets || []).length;
  if (count >= 2) ok(`PO filed a backlog of ${count} tickets`);
  else if (count === 1) bad(`PO filed only 1 ticket (multi-ticket backlog regression?)`);
  else bad('PO filed no tickets');

  // 5) Full: play → first ticket to done → app live + E2E published
  if (FULL && count > 0) {
    await api(`/v1/projects/${SLUG}/play`, { method: 'POST' });
    ok('pressed Play');
    log('  waiting for the first ticket to reach done/failed (≤20m)…');
    const done = await until('done', async () => {
      const t = await api(`/v1/projects/${SLUG}/tickets`);
      const first = (t.body.tickets || []).sort((a, b) => a.seq - b.seq)[0];
      if (!first) return null;
      return ['done', 'failed', 'cancelled'].includes(first.status) ? first : null;
    }, { timeoutMs: 1_200_000, everyMs: 15_000 });
    process.stdout.write('\n');
    if (done?.status === 'done') ok(`ticket #${done.seq} reached done`);
    else bad(`first ticket ended in "${done?.status ?? 'timeout'}" (expected done)`);

    const live = await fetch(`https://${SLUG}.proappstore.online`, { redirect: 'manual' }).then((r) => r.status).catch(() => 0);
    (live >= 200 && live < 400) ? ok(`app live (HTTP ${live})`) : bad(`app not live (HTTP ${live})`);

    const e2e = await fetch(`${KB_BASE}/${SLUG}/.e2e/summary.json?t=${Math.random()}`).then((r) => r.ok ? r.json() : null).catch(() => null);
    if (e2e) ok(`E2E results published (${e2e.passed} passed, ${e2e.failed} failed)`);
    else bad('no E2E results published');
  }

  // KB site (best-effort — kb.yml CI may still be running)
  const site = await fetch(`${KB_BASE}/${SLUG}/`, { redirect: 'manual' }).then((r) => r.status).catch(() => 0);
  if (site >= 200 && site < 400) ok(`KB site live: ${KB_BASE}/${SLUG}/`);
  else log(`  (KB site not up yet — kb.yml CI may still be building: ${KB_BASE}/${SLUG}/ → ${site})`);

  finish();
}

function finish() {
  log(`\n${failed === 0 ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} — ${passed} ok, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('\nharness error:', e); process.exit(1); });
