import { describe, expect, it } from 'vitest';
import { countCoAuthors, isBot, pathExclusion, POLICY_DESCRIPTION, POLICY_VERSION, totalFiles } from './policy.js';

describe('contribution policy v1', () => {
  it('is versioned and describes itself with the same version', () => {
    expect(POLICY_VERSION).toBe(1);
    expect(POLICY_DESCRIPTION.version).toBe(POLICY_VERSION);
    expect(POLICY_DESCRIPTION.tests).toBe('counted');
  });

  it.each([
    ['pnpm-lock.yaml', 'lockfile'], ['apps/web/package-lock.json', 'lockfile'], ['Cargo.lock', 'lockfile'],
    ['README.md', 'prose'], ['docs/guide.mdx', 'prose'], ['notes.txt', 'prose'],
    ['dist/app.js', 'generated'], ['packages/x/build/out.js', 'generated'], ['public/app.min.js', 'generated'], ['app.js.map', 'generated'],
    ['node_modules/a/index.js', 'vendored'], ['vendor/lib.go', 'vendored'],
    ['src/index.ts', null], ['src/index.test.ts', null], ['styles/app.css', null], ['migrations/0001.sql', null],
  ] as const)('%s -> %s', (path, expected) => {
    expect(pathExclusion(path)).toBe(expected);
  });

  it('sums only counted files, and excludes binaries (no patch) and empty changes', () => {
    const totals = totalFiles([
      { filename: 'src/a.ts', additions: 10, deletions: 2, patch: '@@' },
      { filename: 'src/a.test.ts', additions: 5, deletions: 0, patch: '@@' },
      { filename: 'README.md', additions: 100, deletions: 0, patch: '@@' },
      { filename: 'pnpm-lock.yaml', additions: 900, deletions: 800, patch: '@@' },
      { filename: 'logo.png', additions: 0, deletions: 0 },
      { filename: 'big.bin', additions: 40, deletions: 0 },
      { filename: 'src/renamed.ts', additions: 0, deletions: 0, status: 'renamed' },
    ]);
    expect(totals).toEqual({ additions: 15, deletions: 2, filesCounted: 2, filesExcluded: 5 });
  });

  it('counts removals of source files', () => {
    expect(totalFiles([{ filename: 'src/old.ts', additions: 0, deletions: 30, status: 'removed', patch: '@@' }])).toMatchObject({ additions: 0, deletions: 30, filesCounted: 1 });
  });

  it('counts distinct co-author trailers but never more than once each', () => {
    expect(countCoAuthors('fix\n\nCo-authored-by: Ada <a@x.io>\nco-authored-by: ada <A@x.io>\nCo-Authored-By: Bob <b@x.io>')).toBe(2);
    expect(countCoAuthors('plain message')).toBe(0);
  });

  it('recognises bots by type or login suffix, and not ordinary accounts', () => {
    expect(isBot({ type: 'Bot', login: 'x' })).toBe(true);
    expect(isBot({ type: 'User', login: 'dependabot[bot]' })).toBe(true);
    expect(isBot({ type: 'User', login: 'ada' })).toBe(false);
    expect(isBot(null)).toBe(false);
  });
});
