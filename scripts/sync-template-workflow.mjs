#!/usr/bin/env node
/**
 * Keep the template-app repo's deploy workflow in lockstep with the platform's
 * single canonical source.
 *
 * Source of truth:  packages/admin/src/publish.ts → deployWorkflowYaml()
 * Reviewed golden:   packages/admin/src/__fixtures__/canonical-deploy.yml
 *   (a unit test asserts the golden is byte-identical to the generator, so the
 *    golden is always == the generator; this script ships the golden so it never
 *    needs the TS toolchain.)
 * Target:            proappstore-online/template-app:.github/workflows/deploy.yml
 *   (the repo that the CLI + MCP `create_app` clone — that path has NO
 *    strip-and-inject, so its committed workflow must stay canonical.)
 *
 * Usage:
 *   node scripts/sync-template-workflow.mjs --check   # exit 1 if template-app drifted
 *   node scripts/sync-template-workflow.mjs           # push the golden to template-app
 *
 * Auth: uses the `gh` CLI (must be authenticated for proappstore-online).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = 'proappstore-online/template-app';
const WORKFLOW_PATH = '.github/workflows/deploy.yml';
const GOLDEN = fileURLToPath(
  new URL('../packages/admin/src/__fixtures__/canonical-deploy.yml', import.meta.url),
);

const check = process.argv.includes('--check');
const golden = readFileSync(GOLDEN, 'utf8');

function gh(args, input) {
  return execFileSync('gh', args, {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'inherit'],
  });
}

// Fetch the live workflow (content + blob sha). 404 → file doesn't exist yet.
let live = null;
let sha = null;
try {
  const res = JSON.parse(gh(['api', `repos/${REPO}/contents/${WORKFLOW_PATH}`]));
  live = Buffer.from(res.content, 'base64').toString('utf8');
  sha = res.sha;
} catch {
  live = null;
}

const inSync = live === golden;

if (check) {
  if (inSync) {
    console.log(`✓ ${REPO}:${WORKFLOW_PATH} is in sync with the canonical generator.`);
    process.exit(0);
  }
  console.error(`✗ DRIFT: ${REPO}:${WORKFLOW_PATH} differs from the canonical generator.`);
  console.error('  Run `node scripts/sync-template-workflow.mjs` to push the golden.');
  process.exit(1);
}

if (inSync) {
  console.log(`✓ Already in sync — nothing to push.`);
  process.exit(0);
}

// Write mode: PUT the golden.
const contentB64 = Buffer.from(golden, 'utf8').toString('base64');
const args = [
  'api',
  '-X',
  'PUT',
  `repos/${REPO}/contents/${WORKFLOW_PATH}`,
  '-f',
  'message=ci: sync template-app deploy workflow to canonical (deployWorkflowYaml)',
  '-f',
  `content=${contentB64}`,
];
if (sha) args.push('-f', `sha=${sha}`);
gh(args);
console.log(`✓ Pushed canonical workflow to ${REPO}:${WORKFLOW_PATH}`);
