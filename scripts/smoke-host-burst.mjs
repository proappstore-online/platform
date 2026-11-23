#!/usr/bin/env node
/**
 * Post-deploy gate for proappstore-host (#657, #653): bursts of concurrent GETs at
 * the roots of several live apps. A 5xx, a 4xx (a catalogue app's root answers
 * 200; a 404 there is broken routing) or a failed fetch fails the run, and
 * deploy-host.yml then rolls the Worker back.
 *
 * A single request cannot catch the #616 class (state shared across requests in
 * one isolate): it needs overlapping requests. The backend's cron probe
 * (packages/backend/src/lib/host-probe.ts) does the same thing continuously.
 *
 *   node scripts/smoke-host-burst.mjs          `run` + 5 sampled catalogue apps, 8 requests each
 */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const CATALOGUE_URL = 'https://proappstore.online/catalogue.json';
export const BURST = 8;
const SAMPLE = 5;
const ALWAYS = 'run';
const SETTLE_MS = 15_000;

/** Root URLs of `run` plus up to `sample` other catalogue apps, picked at random. */
export function pickRoots(apps, sample = SAMPLE, random = Math.random) {
  const valid = apps.filter((a) => a && typeof a.id === 'string' && typeof a.appUrl === 'string' && a.appUrl.startsWith('https://'));
  const always = valid.find((a) => a.id === ALWAYS) ?? { id: ALWAYS, appUrl: `https://${ALWAYS}.proappstore.online` };
  const rest = valid.filter((a) => a.id !== ALWAYS).map((a) => [random(), a]).sort((x, y) => x[0] - y[0]).slice(0, sample).map(([, a]) => a);
  return [always, ...rest].map((a) => new URL('/', a.appUrl).href);
}

/** One burst of BURST concurrent GETs per root; a line per root where any answered ≥ 400 or failed. */
export async function burstProblems(roots, fetchImpl = fetch) {
  const problems = [];
  for (const url of roots) {
    const results = await Promise.all(Array.from({ length: BURST }, async () => {
      try {
        const res = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000), headers: { 'cache-control': 'no-cache' } });
        await res.body?.cancel();
        return res.status >= 400 ? String(res.status) : null;
      } catch (e) {
        return `fetch failed (${e?.name ?? 'error'})`;
      }
    }));
    const bad = results.filter(Boolean);
    console.log(`${bad.length ? '✗' : '✓'} ${url} ${BURST - bad.length}/${BURST} ok${bad.length ? ` — ${bad.join(', ')}` : ''}`);
    if (bad.length) problems.push(`${url}: ${bad.length}/${BURST} failed (${bad.join(', ')})`);
  }
  return problems;
}

async function main() {
  // Let the new version reach the edge, so the burst exercises it and not the old one.
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  const res = await fetch(CATALOGUE_URL, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${CATALOGUE_URL} answered ${res.status}`);
  const { apps } = await res.json();
  const problems = await burstProblems(pickRoots(Array.isArray(apps) ? apps : []));
  if (problems.length) {
    console.error(`\n::error::app roots failed under concurrent requests:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log('\n✓ every sampled app root answered every concurrent request with a 2xx/3xx.');
}

if (resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] ?? '')) await main();
