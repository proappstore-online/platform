import { describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
// @ts-expect-error plain Node verification entry point
import { commandFor, executeCommand, gates, gateStatus, releasePassed, run, supportedToolchain } from '../scripts/verification.mjs';

describe('required verification report (#554)', () => {
  it('retains all mandatory gates, including coverage, both browsers and real D1', () => {
    expect(gates.map(([id]: string[]) => id)).toEqual([
      'install', 'build', 'design', 'deploy-paths', 'knip', 'typecheck', 'unit',
      'coverage', 'offline-browser', 'google-consent-browser', 'docs', 'runtime',
      'template-drift', 'skills',
    ]);
  });

  it('never converts a local deferral or failed gate into a release pass', () => {
    const results = gates.map(([id]: string[]) => ({ id, status: 'passed', exitCode: 0 }));
    expect(releasePassed(results)).toBe(true);
    expect(releasePassed(results.slice(1))).toBe(false);
    for (const status of ['pending-posix', 'failed', 'timed-out', 'ready']) {
      expect(releasePassed([{ ...results[0], status }, ...results.slice(1)])).toBe(false);
    }
    expect(gateStatus('win32', true)).toBe('pending-posix');
    expect(gateStatus('linux', true)).toBe('ready');
    expect(gateStatus('win32', false)).toBe('ready');
  });

  it('requires each named gate exactly once with a successful exit code', () => {
    const results = gates.map(([id]: string[]) => ({ id, status: 'passed', exitCode: 0 }));
    expect(releasePassed([...results].reverse())).toBe(true);
    expect(releasePassed([results[1], ...results.slice(1)])).toBe(false);
    expect(releasePassed([{ ...results[0], id: 'unknown' }, ...results.slice(1)])).toBe(false);
    expect(releasePassed([{ ...results[0], exitCode: null }, ...results.slice(1)])).toBe(false);
    expect(releasePassed([{ ...results[0], exitCode: 1 }, ...results.slice(1)])).toBe(false);
  });

  it('invokes pnpm through Node with literal arguments rather than a cmd shell', () => {
    const entry = 'C:\\Program Files\\pnpm\\pnpm.cjs';
    expect(commandFor('pnpm', ['-r', '--filter', './packages/*', 'build'], { npm_execpath: entry }))
      .toEqual([process.execPath, [entry, '-r', '--filter', './packages/*', 'build']]);
    expect(() => commandFor('pnpm', [], {})).toThrow('Run through pnpm verify');
    expect(commandFor('bash', ['scripts/check-design-system.sh', '.'], { PAS_VERIFY_BASH: '/bin/bash' }))
      .toEqual(['/bin/bash', ['scripts/check-design-system.sh', '.']]);
  });

  it('requires the CI toolchain for a release result', () => {
    expect(supportedToolchain('v22.20.0', '10.30.3')).toBe(true);
    expect(supportedToolchain('v24.12.0', '10.30.3')).toBe(false);
    expect(supportedToolchain('v22.20.0', '10.29.0')).toBe(false);
  });
});

describe('verification runner lifecycle (#554)', () => {
  function output() {
    const log = new PassThrough();
    let text = '';
    log.on('data', data => { text += data.toString(); });
    return { log, text: () => text };
  }

  it('captures a real successful subprocess and its output', async () => {
    const capture = output();
    const result = await executeCommand(process.execPath, ['-e', 'console.log("evidence")'], { log: capture.log });
    expect(result).toMatchObject({ status: 'passed', exitCode: 0 });
    expect(capture.text()).toContain('evidence');
  });

  it('captures a real nonzero exit and stderr', async () => {
    const capture = output();
    const result = await executeCommand(process.execPath, ['-e', 'console.error("failure evidence"); process.exitCode = 7'], { log: capture.log });
    expect(result).toMatchObject({ status: 'failed', exitCode: 7 });
    expect(capture.text()).toContain('failure evidence');
  });

  it('reports a missing executable without hanging', async () => {
    const result = await executeCommand(join(tmpdir(), 'pas-nonexistent-executable-554'), [], { log: output().log });
    expect(result).toMatchObject({ status: 'failed', exitCode: null });
    expect(result.detail).toContain('ENOENT');
  });

  it('terminates a real long-running subprocess within the bounded cleanup window', async () => {
    const started = Date.now();
    const result = await executeCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      log: output().log, timeoutMs: 150, cleanupMs: 500,
    });
    expect(result.status).toBe('timed-out');
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it.each(['spawn-error', 'nonzero', 'throw'])(
    'bounds Windows cleanup when taskkill has a %s', async failure => {
      const capture = output();
      const children: ReturnType<typeof spawn>[] = [];
      const spawnProcess = (exe: string, args: string[], options: Parameters<typeof spawn>[2]) => {
        let child;
        if (exe !== 'taskkill') child = spawn(exe, args, options);
        else if (failure === 'throw') throw new Error('termination unavailable');
        else if (failure === 'spawn-error') child = spawn(join(tmpdir(), 'pas-missing-taskkill-554'), [], options);
        else child = spawn(process.execPath, ['-e', 'process.exit(9)'], options);
        children.push(child);
        return child;
      };
      try {
        const started = Date.now();
        const result = await executeCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          log: capture.log, timeoutMs: 150, cleanupMs: 500, platform: 'win32', spawnProcess,
        });
        expect(result.status).toBe('timed-out');
        expect(result.detail).toContain('cleanup deadline');
        expect(capture.text()).toContain('WARNING:');
        expect(capture.text()).toContain('Descendants may remain');
        expect(Date.now() - started).toBeLessThan(2500);
      } finally {
        // This test deliberately simulates failed termination; clean up its real children.
        for (const child of children) if (child.pid && child.exitCode === null) child.kill();
      }
    },
  );

  it.each(['unchanged', 'head', 'working-tree'])(
    'persists logs/report and detects %s candidate inputs in an isolated repository', async change => {
      const root = mkdtempSync(join(tmpdir(), 'pas-verification-554-'));
      const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
      try {
        git('init');
        git('config', 'user.email', 'verification@example.invalid');
        git('config', 'user.name', 'Verification test');
        git('config', 'commit.gpgsign', 'false');
        writeFileSync(join(root, '.gitignore'), 'artifacts/\n');
        writeFileSync(join(root, 'input.txt'), 'original');
        git('add', '.');
        git('commit', '-m', 'initial fixture');
        const revision = git('rev-parse', 'HEAD').trim();
        const script = change === 'head'
          ? 'require("node:child_process").execFileSync("git", ["commit", "--allow-empty", "-m", "changed HEAD"]);'
          : change === 'working-tree'
            ? 'require("node:fs").writeFileSync("input.txt", "changed");'
            : '';
        const report = await run(root, {
          selectedGates: [['fixture', 'node', ['-e', `${script} console.log("persisted evidence");`]]],
          pnpmVersion: '10.30.3',
        });
        const persisted = JSON.parse(readFileSync(join(root, 'artifacts/verification/report.json'), 'utf8'));
        expect(persisted).toEqual(report);
        expect(persisted.results[0]).toMatchObject({ id: 'fixture', status: 'passed', exitCode: 0 });
        expect(readFileSync(join(root, 'artifacts/verification/fixture.log'), 'utf8')).toContain('persisted evidence');
        expect(readFileSync(join(root, 'artifacts/verification/working-tree.patch'), 'utf8')).toBe('');
        expect(report.input.revision).toBe(revision);
        expect(report.inputUnchanged).toBe(change === 'unchanged');
        expect(report.releasePassed).toBe(false); // A fixture command cannot replace mandatory gates.
        if (change === 'head') {
          expect(report.finalInput.revision).not.toBe(revision);
          expect(report.finalInput.patchSha256).toBe(report.input.patchSha256);
        }
        if (change === 'working-tree') expect(report.finalInput.patchSha256).not.toBe(report.input.patchSha256);
      } finally { rmSync(root, { recursive: true, force: true }); }
    },
  );
});
