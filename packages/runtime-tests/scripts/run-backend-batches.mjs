#!/usr/bin/env node
// Runs the backend runtime suite (vitest.backend.ts) as several sequential batches, each in its OWN
// vitest process and therefore its own workerd process (#543).
//
// Why: the whole suite used to run as one process, so a native workerd crash (a SIGSEGV seen on macOS)
// ended the run at an unreported file and hid every file after it. Batches contain a native fault to
// one group, name that group, and still run and report the others. They do not hide it.
//
//   - Every test file in test/backend runs exactly once: the script checks the batches partition the
//     directory, and a missing or renamed isolated file fails the run instead of shrinking it.
//   - A failing batch never stops the later ones, and the run exits non-zero if any batch failed.
//   - There is no retry. A suspected native crash is reported as one, never turned into a pass.
//   - The Room / WebSocket Durable Object files (the one class of test that holds sockets and alarms
//     in workerd) run together, last, apart from everything else.
//
//   node scripts/run-backend-batches.mjs                 all batches
//   node scripts/run-backend-batches.mjs --list          show the batches and their files
//   node scripts/run-backend-batches.mjs --batch rooms   one batch (a name or a 1-based number)
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const SUITE = 'test/backend';
const ROOM_FILES = ['room-publish', 'room-seq-durable', 'rooms-do', 'visibility'].map((n) => `${n}.test.ts`);
const GENERAL_BATCHES = 2;

export function planBatches(all) {
  const missing = ROOM_FILES.filter((f) => !all.includes(f));
  if (missing.length) throw new Error(`isolated room test file(s) not found: ${missing.join(', ')} (renamed? update ROOM_FILES)`);
  const rest = all.filter((f) => !ROOM_FILES.includes(f));
  const size = Math.ceil(rest.length / GENERAL_BATCHES);
  const batches = Array.from({ length: GENERAL_BATCHES }, (_, i) => ({ name: `general-${i + 1}`, files: rest.slice(i * size, (i + 1) * size) }))
    .filter((b) => b.files.length);
  batches.push({ name: 'rooms', files: ROOM_FILES });
  const flat = batches.flatMap((b) => b.files);
  if (flat.length !== all.length || new Set(flat).size !== all.length || !all.every((f) => flat.includes(f))) {
    throw new Error('the batches do not partition test/backend: a file would be skipped or run twice');
  }
  return batches;
}

const NATIVE = /SIGSEGV|segmentation fault|segfault|workerd[^\n]{0,80}(exited|crash|terminated|killed)|Miniflare[^\n]{0,60}(exited|crash)/i;
// Exit by signal, or a native fault code (139 = 128 + SIGSEGV; 0xC0000005 = a Windows access violation).
const nativeExit = (code, signal) => signal !== null || code === 139 || code === 3221225477;

function runBatch(batch, vitestEntry) {
  return new Promise((resolve) => {
    const args = [vitestEntry, 'run', '--config', 'vitest.backend.ts', ...batch.files.map((f) => `${SUITE}/${f}`)];
    const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let tail = '';
    const keep = (chunk) => { tail = (tail + chunk).slice(-200_000); };
    child.stdout.on('data', (d) => { process.stdout.write(d); keep(d.toString()); });
    child.stderr.on('data', (d) => { process.stderr.write(d); keep(d.toString()); });
    child.on('error', (error) => resolve({ code: 1, signal: null, native: false, error }));
    child.on('close', (code, signal) => resolve({ code, signal, native: nativeExit(code, signal) || (code !== 0 && NATIVE.test(tail)) }));
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const all = readdirSync(join(root, SUITE)).filter((f) => f.endsWith('.test.ts')).sort();
  const batches = planBatches(all);
  if (argv.includes('--list')) {
    for (const [i, b] of batches.entries()) console.log(`${i + 1}. ${b.name} (${b.files.length} files)\n   ${b.files.join('\n   ')}`);
    return 0;
  }
  const only = argv.includes('--batch') ? argv[argv.indexOf('--batch') + 1] : undefined;
  const chosen = only === undefined ? batches : batches.filter((b, i) => b.name === only || String(i + 1) === only);
  if (!chosen.length) { console.error(`no such batch: ${only}. Batches: ${batches.map((b) => b.name).join(', ')}`); return 2; }

  const vitestEntry = join(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');
  const results = [];
  for (const batch of chosen) {
    console.log(`\n=== backend batch ${batch.name}: ${batch.files.length} files, its own workerd process ===`);
    results.push({ batch, ...(await runBatch(batch, vitestEntry)) });
  }

  console.log('\n=== backend runtime batches ===');
  for (const r of results) {
    const how = r.code === 0 ? 'passed' : r.native ? `NATIVE CRASH SUSPECTED (exit ${r.code}${r.signal ? `, signal ${r.signal}` : ''})` : `failed (exit ${r.code})`;
    console.log(`${r.code === 0 ? 'ok  ' : 'FAIL'} ${r.batch.name.padEnd(10)} ${String(r.batch.files.length).padStart(3)} files  ${how}`);
  }
  const bad = results.filter((r) => r.code !== 0);
  if (bad.length) {
    console.error(`\n${bad.length} of ${results.length} batches failed. Re-run one: node scripts/run-backend-batches.mjs --batch ${bad[0].batch.name}`);
    if (bad.some((r) => r.native)) console.error('A native workerd crash is a failure, not a flake: see packages/runtime-tests/MACOS_CRASH_DIAGNOSIS.md (#543).');
    return 1;
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(await main());
