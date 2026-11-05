import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep every command in CLAUDE.md represented, including gates deferred by Windows.
export const gates = [
  ['install', 'pnpm', ['install', '--frozen-lockfile']],
  ['build', 'pnpm', ['-r', '--filter', './packages/*', 'build']],
  ['design', 'bash', ['scripts/check-design-system.sh', '.'], true],
  ['deploy-paths', 'node', ['scripts/check-deploy-paths.mjs']],
  ['knip', 'pnpm', ['knip']],
  ['typecheck', 'pnpm', ['-r', 'typecheck']],
  ['unit', 'pnpm', ['test'], true],
  ['coverage', 'pnpm', ['test:coverage'], true],
  ['offline-browser', 'pnpm', ['test:offline-browser']],
  ['google-consent-browser', 'pnpm', ['test:google-consent-browser']],
  ['docs', 'pnpm', ['docs:build']],
  ['runtime', 'pnpm', ['test:runtime']],
  ['template-drift', 'node', ['scripts/sync-template-workflow.mjs', '--check']],
  ['skills', 'node', ['scripts/build-skills-manifest.mjs', '--check']],
];

export function gateStatus(platform, posix) {
  return platform === 'win32' && posix ? 'pending-posix' : 'ready';
}

export function releasePassed(results) {
  return results.length === gates.length && gates.every(([id]) => {
    const matches = results.filter(result => result.id === id);
    return matches.length === 1 && matches[0].status === 'passed' && matches[0].exitCode === 0;
  });
}

export function supportedToolchain(node, pnpm) {
  return /^v22\./.test(node) && pnpm === '10.30.3';
}

export function commandFor(command, args, env = process.env) {
  if (command === 'node') return [process.execPath, args];
  if (command === 'pnpm') {
    // pnpm supplies its JS entry point. Do not spawn a .cmd through an implicit shell.
    if (!env.npm_execpath || !/pnpm\.(?:c?js|mjs)$/.test(env.npm_execpath)) {
      throw new Error('Run through pnpm verify so npm_execpath identifies the supported pnpm entry point');
    }
    return [process.execPath, [env.npm_execpath, ...args]];
  }
  return [env.PAS_VERIFY_BASH || 'bash', args];
}

// Cleanup gets its own short deadline: failed tree termination must not hang reporting.
export async function executeCommand(exe, argv, { root, log, timeoutMs = 600_000, cleanupMs = 3_000, platform = process.platform, spawnProcess = spawn } = {}) {
  let child, killer, timer, fallback;
  let timedOut = false;
  const warnings = [];
  const warn = message => { warnings.push(message); log.write(`WARNING: ${message}\n`); };
  const outcome = await new Promise(done => {
    let settled = false;
    const finish = value => { if (!settled) { settled = true; done(value); } };
    try {
      child = spawnProcess(exe, argv, { cwd: root, windowsHide: true, detached: platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.pipe(log, { end: false });
      child.stderr.pipe(log, { end: false });
      child.once('error', error => finish({ error: error.message }));
      child.once('close', (code, signal) => finish({ code, signal }));
      timer = setTimeout(() => {
        timedOut = true;
        fallback = setTimeout(() => {
          warn('Process did not close within the cleanup deadline; continuing with a failed timeout result. Descendants may remain.');
          child.stdout.unpipe(log); child.stderr.unpipe(log);
          child.stdout.destroy(); child.stderr.destroy(); child.unref();
          if (killer) { killer.kill(); killer.unref(); }
          finish({ error: 'Termination cleanup deadline exceeded' });
        }, cleanupMs);
        try {
          if (platform === 'win32') {
            killer = spawnProcess('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            killer.once('error', error => warn(`taskkill failed: ${error.message}`));
            killer.once('close', code => { if (code !== 0) warn(`taskkill exited ${code}`); });
          } else if (child.pid) {
            process.kill(-child.pid, 'SIGKILL');
          }
        } catch (error) { warn(`Process tree termination failed: ${error.message}`); }
      }, timeoutMs);
    } catch (error) { finish({ error: error.message }); }
  });
  clearTimeout(timer); clearTimeout(fallback);
  if (killer) { killer.removeAllListeners('close'); killer.unref(); }
  return {
    exitCode: outcome.code ?? null,
    status: timedOut ? 'timed-out' : outcome.code === 0 ? 'passed' : 'failed',
    ...(outcome.error || outcome.signal ? { detail: outcome.error || outcome.signal } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

export async function run(root, { selectedGates = gates, pnpmVersion, timeoutMs, cleanupMs } = {}) {
  const directory = resolve(root, 'artifacts/verification');
  mkdirSync(directory, { recursive: true });
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const hash = content => createHash('sha256').update(content).digest('hex');
  const identity = () => ({
    revision: git(['rev-parse', 'HEAD']),
    patchSha256: hash(execFileSync('git', ['diff', 'HEAD', '--binary'], { cwd: root })),
    untracked: Object.fromEntries(execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' })
      .split('\0').filter(Boolean).map(path => [path, hash(readFileSync(resolve(root, path)))])),
  });
  const report = {
    revision: git(['rev-parse', 'HEAD']),
    // HEAD alone cannot identify a dirty feature checkout. Retain the exact patch and status.
    workingTree: git(['status', '--porcelain=v1', '--untracked-files=all']),
    platform: process.platform, node: process.version,
    pnpm: pnpmVersion ?? execFileSync(...commandFor('pnpm', ['--version']), { encoding: 'utf8' }).trim(),
    input: identity(),
    started: new Date().toISOString(), results: [], releasePassed: false,
  };
  writeFileSync(resolve(directory, 'working-tree.patch'), execFileSync('git', ['diff', 'HEAD', '--binary'], { cwd: root }));
  report.supportedToolchain = supportedToolchain(report.node, report.pnpm);
  if (!report.supportedToolchain) console.log('Toolchain differs from CI: use Node 22 and pnpm 10.30.3. Local results cannot certify release.');
  const save = () => writeFileSync(resolve(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  save();
  for (const [id, command, args, posix] of selectedGates) {
    const result = { id, command: [command, ...args], status: gateStatus(process.platform, posix), exitCode: null };
    report.results.push(result);
    if (result.status === 'pending-posix') {
      console.log(`${id}: PENDING — mandatory on a supported POSIX runner (no local pass claimed)`);
      save();
      continue;
    }
    console.log(`${id}: running (log: artifacts/verification/${id}.log)`);
    result.status = 'running';
    save();
    const log = createWriteStream(resolve(directory, `${id}.log`));
    try {
      const [exe, argv] = commandFor(command, args);
      Object.assign(result, await executeCommand(exe, argv, { root, log, timeoutMs, cleanupMs }));
    } catch (error) { result.status = 'failed'; result.detail = error.message; }
    await new Promise(done => log.end(done));
    console.log(`${id}: ${result.status} (exit ${result.exitCode})`);
    save();
  }
  report.finished = new Date().toISOString();
  // Compare HEAD as well as dirty contents: two clean commits have the same empty patch.
  report.finalInput = identity();
  report.inputUnchanged = JSON.stringify(report.input) === JSON.stringify(report.finalInput);
  report.releasePassed = report.supportedToolchain && report.inputUnchanged && releasePassed(report.results);
  save();
  console.log(report.releasePassed ? 'All mandatory gates passed.' : 'Release verification incomplete. See artifacts/verification/report.json.');
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await run(fileURLToPath(new URL('..', import.meta.url)));
  process.exitCode = report.releasePassed ? 0 : 1;
}
