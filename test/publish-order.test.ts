import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// #437: publish.yml must publish a package after every workspace package it depends
// on. pnpm pins a workspace:* dependency to the version present at pack time, so
// cli published before compliance's bump pinned the previous compliance release.
const ROOT = new URL('../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), 'utf8');

describe('publish.yml order (#437)', () => {
  it('publishes each package after the workspace packages it depends on', () => {
    const order = /for PKG in ([a-z -]+); do/.exec(read('.github/workflows/publish.yml'))![1]!.trim().split(/\s+/);
    const nameOf = (dir: string) => (JSON.parse(read(`packages/${dir}/package.json`)) as { name: string }).name;
    const dirOf = new Map(order.map((d) => [nameOf(d), d]));
    for (const [i, dir] of order.entries()) {
      const deps = (JSON.parse(read(`packages/${dir}/package.json`)) as { dependencies?: Record<string, string> }).dependencies ?? {};
      for (const [dep, spec] of Object.entries(deps)) {
        if (!spec.startsWith('workspace:') || !dirOf.has(dep)) continue;
        expect(order.indexOf(dirOf.get(dep)!), `${dir} depends on ${dep}`).toBeLessThan(i);
      }
    }
    expect(order).toEqual(['compliance', 'sdk', 'cli']);
  });
});
