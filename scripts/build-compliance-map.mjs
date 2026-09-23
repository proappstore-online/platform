#!/usr/bin/env node
/**
 * Publish the compliance-check → clause mapping (#166) as
 * docs/standard/compliance-checks.json, from the TypeScript source of truth
 * packages/compliance/src/clause-map.ts (dependency-free, loaded via Node's
 * type stripping). `--check` exits non-zero when the committed file differs.
 * The compliance package's clause-map.test.ts enforces the same golden.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs/standard/compliance-checks.json');
const { complianceMap } = await import(pathToFileURL(join(ROOT, 'packages/compliance/src/clause-map.ts')).href);
const standard = JSON.parse(readFileSync(join(ROOT, 'docs/standard/standard.json'), 'utf8'));
const json = JSON.stringify({ ...complianceMap(), standard_version: standard.standard.version }, null, 2) + '\n';

if (process.argv.includes('--check')) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : null;
  if (current !== json) { console.error('✗ docs/standard/compliance-checks.json is out of date — run: node scripts/build-compliance-map.mjs'); process.exit(1); }
  console.log('✓ docs/standard/compliance-checks.json is up to date');
} else {
  writeFileSync(OUT, json);
  console.log('wrote docs/standard/compliance-checks.json');
}
