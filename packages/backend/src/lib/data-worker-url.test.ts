import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { dataWorkerUrl } from './data-worker-url.js';

// #153, #303 M4/N20: backend-internal calls reach a data worker on its workers.dev
// host, built by dataWorkerUrl(). The public data-<app>.proappstore.online host is
// the browser path through the host worker; a backend fetch of it is a same-zone
// proxy hop that has failed on healthy workers.

const SRC = fileURLToPath(new URL('..', import.meta.url));
// The one legitimate use: the route pattern a data worker is deployed under, not a fetch.
const ALLOWED = new Set(['lib/deploy-worker.ts']);
const PUBLIC_HOST = /data-\$\{[^}]+\}\.(?:proappstore\.online|\$\{)|https:\/\/data-\$\{/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('dataWorkerUrl', () => {
  it('builds the direct workers.dev URL and refuses a missing host', () => {
    expect(dataWorkerUrl({ DATA_WORKER_HOST: 'acct.workers.dev' }, 'chess', '/query')).toBe('https://pas-data-chess.acct.workers.dev/query');
    expect(() => dataWorkerUrl({}, 'chess', '/query')).toThrow('DATA_WORKER_HOST is not configured');
  });

  it('is the only way backend source reaches a data worker: no public data-* host URLs (#303 M4/N20)', () => {
    const offenders = sources(SRC)
      .map((path) => relative(SRC, path).split('\\').join('/'))
      .filter((path) => !ALLOWED.has(path))
      .flatMap((path) => readFileSync(join(SRC, path), 'utf8').split('\n')
        .map((line, i) => (PUBLIC_HOST.test(line) ? `${path}:${i + 1}: ${line.trim()}` : null))
        .filter((hit): hit is string => hit !== null));
    expect(offenders).toEqual([]);
  });
});
