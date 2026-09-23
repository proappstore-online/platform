#!/usr/bin/env node
/**
 * Publish the approved-template catalogue (#178) as docs/templates/catalogue.json
 * from the TypeScript source of truth packages/build-core/src/template-catalogue.ts
 * (dependency-free; loaded via Node type stripping). `--check` exits non-zero
 * when the committed file differs. build-core's template-catalogue.test.ts
 * enforces the same golden.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs/templates/catalogue.json');
const { templateCatalogueJson } = await import(pathToFileURL(join(ROOT, 'packages/build-core/src/template-catalogue.ts')).href);
const json = JSON.stringify(templateCatalogueJson(), null, 2) + '\n';

if (process.argv.includes('--check')) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : null;
  if (current !== json) { console.error('✗ docs/templates/catalogue.json is out of date — run: node scripts/build-template-catalogue.mjs'); process.exit(1); }
  console.log('✓ docs/templates/catalogue.json is up to date');
} else {
  writeFileSync(OUT, json);
  console.log('wrote docs/templates/catalogue.json');
}
