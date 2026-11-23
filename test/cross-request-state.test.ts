import { describe, expect, it } from 'vitest';
// @ts-expect-error -- a plain .mjs CI script, no type declarations
import { checkCrossRequestState, findCrossRequestState, workerPackages } from '../scripts/check-cross-request-state.mjs';

// #655 (#653): module scope is shared by every request an isolate serves, and a
// promise awaited by a request other than the one that created it fails once that
// request ends (#616). scripts/check-cross-request-state.mjs keeps promises out
// of module scope in Worker code; these tests pin the repo and the checker.

const find = (text: string): string[] => findCrossRequestState('x.ts', text);

describe('no module-scope promises in Worker code (#655)', () => {
  it('the repo has none', () => {
    expect(checkCrossRequestState()).toEqual([]);
  });

  it('scans every deployed Worker and what it bundles, not the browser SDK or the CLI', () => {
    const pkgs = workerPackages() as string[];
    for (const p of ['backend', 'host', 'admin', 'mcp', 'kb-host', 'qa-worker', 'agent-teams', 'data-worker', 'build-core']) expect(pkgs).toContain(p);
    expect(pkgs).not.toContain('sdk');
    expect(pkgs).not.toContain('cli');
  });

  it('flags the shapes behind #616', () => {
    expect(find('let inflight: Promise<string> | undefined;')).toEqual(['1: inflight — module-scope state holding a Promise']);
    expect(find('const m = new Map<string, Promise<string>>();')).toEqual(['1: m — module-scope state holding a Promise']);
    expect(find('export const m: Map<string, Promise<number>> = new Map();')).toEqual(['1: m — module-scope state holding a Promise']);
    expect(find('let once;\nexport function get() { once ??= load(); return once; }')).toEqual(['1: once — module-scope let/var assigned with ??=']);
  });

  it('allows plain data, functions returning promises, locals, and code inside strings', () => {
    expect(find('let cache: { apps: string[]; until: number } | undefined;')).toEqual([]);
    expect(find('const RUNNERS: { run: (s: string) => Promise<void> }[] = [];')).toEqual([]);
    expect(find('function f() { let p: Promise<void> | undefined; p ??= g(); return p; }')).toEqual([]);
    expect(find('const FILE = `let once: Promise<T> | undefined;\\nonce ??= mint();`;')).toEqual([]);
    expect(find('const o = { x: undefined as string | undefined };\no.x ??= "a";')).toEqual([]);
  });

  it('honours an allow comment with a reason on the line above', () => {
    expect(find('// cross-request-ok: resolved synchronously at module load\nlet p: Promise<void> = Promise.resolve();')).toEqual([]);
    expect(find('// cross-request-ok:\nlet p: Promise<void> = Promise.resolve();')).toHaveLength(1);
  });
});
