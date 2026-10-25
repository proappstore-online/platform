import { describe, expect, it } from 'vitest';
// @ts-expect-error -- a plain .mjs CI script, no type declarations
import { findOrphanDataWorkers } from '../scripts/data-worker-drift.mjs';

// #446: a pas-data-<id> worker with no apps row is skipped by every fleet rollout.
describe('data worker drift (#446)', () => {
  const scripts = ['proappstore-api', 'proappstore-host', 'pas-data-chess-academy', 'pas-data-micro', 'pas-data-prolang', 'pas-app-chess-academy'];

  it('reports pas-data-* workers without a registry row, and only those', () => {
    expect(findOrphanDataWorkers(scripts, ['chess-academy'])).toEqual(['micro', 'prolang']);
  });

  it('is clean when every data worker is registered; other workers are ignored', () => {
    expect(findOrphanDataWorkers(scripts, ['chess-academy', 'micro', 'prolang'])).toEqual([]);
  });

  it('an allowlisted id is acknowledged without hiding other drift', () => {
    expect(findOrphanDataWorkers(scripts, ['chess-academy'], ['micro'])).toEqual(['prolang']);
  });

  it('a registered app without a worker is not drift of this kind, and a bare prefix is ignored', () => {
    expect(findOrphanDataWorkers(['pas-data-'], ['ghost'])).toEqual([]);
  });
});
