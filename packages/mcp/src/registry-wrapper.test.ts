import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const filename = new URL('../../mcp-registry/bin/cli.js', import.meta.url);
const localRequire = createRequire(filename);

describe('npm stdio bridge lifecycle', () => {
  function launch() {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    const spawn = vi.fn(() => child);
    const proc = Object.assign(new EventEmitter(), { execPath: process.execPath, exitCode: 0 });
    const require = Object.assign((name: string) => name === 'node:child_process' ? { spawn } : localRequire(name), { resolve: localRequire.resolve });
    runInNewContext(readFileSync(filename, 'utf8'), { require, process: proc, console: { error: vi.fn() } });
    return { child, proc, spawn };
  }

  it('starts the installed pinned bridge without nested npx or install prompts', () => {
    const { spawn } = launch();
    const binary = localRequire.resolve('mcp-remote/dist/proxy.js');
    expect(existsSync(binary)).toBe(true);
    expect(spawn).toHaveBeenCalledWith(process.execPath, [binary, 'https://mcp.proappstore.online/mcp'], { stdio: 'inherit' });
  });

  it('forwards termination and preserves child exit status', () => {
    const { child, proc } = launch();
    proc.emit('SIGTERM');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('exit', 7, null);
    expect(proc.exitCode).toBe(7);
  });

  it('reports startup failure and signal termination as failures', () => {
    const { child, proc } = launch();
    child.emit('error', new Error('start failed'));
    expect(proc.exitCode).toBe(1);
    child.emit('exit', null, 'SIGTERM');
    expect(proc.exitCode).toBe(143);
  });
});
