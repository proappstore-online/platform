#!/usr/bin/env node
// PAS build container entrypoint (ADR-006, Phase 1).
//
// One job per container run: clone the repo at the pushed SHA, install, build
// (layout-adaptive), and sync the output to the pas-apps R2 bucket under
// apps/<appId>/. Deliberately reuses the SAME upload path as the legacy deploy
// workflow (`aws s3 sync` → R2 S3 endpoint) so the hosting behaviour is
// byte-for-byte identical during migration.
//
// Inputs (env, validated by parseJob):
//   BUILD_REPO       owner/name
//   BUILD_SHA        40-hex commit to pin to
//   BUILD_APP_ID     target app id (R2 prefix)
//   BUILD_TOKEN      GitHub App installation token (short-lived, repo-scoped)
//   R2_BUCKET        default "pas-apps"
//   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / R2_ACCOUNT_ID  (R2 S3 creds)
//
// Exit code is the build result; stdout/stderr are captured by the orchestrator
// as the build log. NEVER print BUILD_TOKEN or the clone URL.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseJob, locateDist, cloneUrl } from './lib.mjs';

function run(cmd, args, cwd) {
  // Inherit stdio so build output streams into the captured log. Throws (exits
  // the container non-zero) on any failure — the orchestrator routes that back.
  execFileSync(cmd, args, { cwd, stdio: 'inherit', env: process.env });
}

function main() {
  const job = parseJob(process.env);
  const token = process.env.BUILD_TOKEN;
  const workdir = mkdtempSync(join(tmpdir(), 'pas-build-'));

  console.log(`[build] ${job.repo}@${job.sha.slice(0, 7)} → ${job.destination}`);

  // 1. Clone exactly the pushed commit (shallow, single commit).
  run('git', ['init', '-q'], workdir);
  run('git', ['remote', 'add', 'origin', cloneUrl(job.repo, token)], workdir);
  run('git', ['fetch', '-q', '--depth=1', 'origin', job.sha], workdir);
  run('git', ['checkout', '-q', job.sha], workdir);

  // 2. Install + build. --no-frozen-lockfile mirrors the canonical workflow
  //    (agents/clones may carry no lockfile or a drifted one).
  run('pnpm', ['install', '--no-frozen-lockfile'], workdir);
  // Layout-adaptive build, same as deployWorkflowYaml: try root build, fall back
  // to a web/ sub-package vite build.
  try {
    run('pnpm', ['build'], workdir);
  } catch {
    if (existsSync(join(workdir, 'web'))) run('npx', ['vite', 'build'], join(workdir, 'web'));
    else throw new Error('pnpm build failed and no web/ sub-package to fall back to');
  }

  // 3. Locate output + upload to R2 (same S3 sync as the legacy workflow).
  const distDir = locateDist((p) => existsSync(join(workdir, p)));
  const endpoint = `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  run(
    'aws',
    ['s3', 'sync', join(workdir, distDir), job.destination,
     '--endpoint-url', endpoint, '--delete', '--no-progress'],
    workdir,
  );

  console.log(`[build] done: apps/${job.appId} from ${job.sha.slice(0, 7)}`);
}

try {
  main();
} catch (err) {
  console.error(`[build] FAILED: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
