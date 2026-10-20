#!/usr/bin/env node
/**
 * Prod smoke for default-open capabilities (#436): a live hosted app answers with
 * every browser feature allowed on its own origin and an open CSP for what it
 * loads and talks to. The expected feature list is read from the host's source
 * of truth (packages/host/src/capabilities.ts), so this cannot drift from it.
 *
 *   node scripts/smoke-capability-headers.mjs [url ...]
 *   (default: https://chess-academy.proappstore.online/)
 *
 * Retries a few times: right after a deploy the edge may still serve the old worker.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('../packages/host/src/capabilities.ts', import.meta.url)), 'utf8');
const list = source.slice(source.indexOf('HOSTED_APP_FEATURES = ['), source.indexOf('] as const'));
const FEATURES = [...list.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
if (FEATURES.length < 20) throw new Error(`could not read HOSTED_APP_FEATURES from capabilities.ts (got ${FEATURES.length})`);

const CSP_EXPECT = {
  'connect-src': ["'self'", 'https:', 'wss:'],
  'media-src': ['blob:', 'mediastream:', 'https:'],
  'worker-src': ["'self'", 'blob:'],
  'frame-src': ["'self'", 'https:'],
  'script-src': ["'wasm-unsafe-eval'", 'https:'],
};

function problems(headers) {
  const out = [];
  const pp = new Set((headers.get('permissions-policy') ?? '').split(',').map((s) => s.trim()));
  for (const f of FEATURES) if (!pp.has(`${f}=(self)`)) out.push(`Permissions-Policy lacks ${f}=(self)`);
  for (const entry of pp) if (/=\(\)$/.test(entry)) out.push(`Permissions-Policy blocks ${entry}`);
  const csp = Object.fromEntries((headers.get('content-security-policy') ?? '').split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
  for (const [directive, needed] of Object.entries(CSP_EXPECT)) {
    for (const value of needed) if (!(csp[directive] ?? []).includes(value)) out.push(`CSP ${directive} lacks ${value}`);
  }
  return out;
}

const urls = process.argv.slice(2).length ? process.argv.slice(2) : ['https://chess-academy.proappstore.online/'];
let failed = false;
for (const url of urls) {
  let last = [];
  for (let attempt = 1; attempt <= 6; attempt++) {
    const res = await fetch(url, { redirect: 'manual' });
    last = res.status >= 400 ? [`HTTP ${res.status}`] : problems(res.headers);
    if (!last.length) break;
    if (attempt < 6) await new Promise((r) => setTimeout(r, 10_000));
  }
  if (last.length) {
    failed = true;
    console.error(`✗ ${url}\n  ${last.join('\n  ')}`);
  } else {
    console.log(`✓ ${url}: ${FEATURES.length} features =(self), CSP open (${Object.keys(CSP_EXPECT).join(', ')})`);
  }
}
process.exit(failed ? 1 : 0);
