import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error -- a plain .mjs CI script, no type declarations
import { BURST, burstProblems, pickRoots } from '../scripts/smoke-host-burst.mjs';

// #657: deploy-host.yml verifies a host release with concurrent bursts across
// several live apps and rolls back on any 5xx.

const apps = ['meet', 'run', 'kanban', 'crm', 'jobs', 'ski', 'cv'].map((id) => ({ id, appUrl: `https://${id}.proappstore.online` }));

describe('smoke-host-burst (#657)', () => {
  it('always samples run, plus up to five other apps', () => {
    const roots = pickRoots(apps) as string[];
    expect(roots[0]).toBe('https://run.proappstore.online/');
    expect(roots).toHaveLength(6);
    expect(new Set(roots).size).toBe(6);
    expect(pickRoots([])).toEqual(['https://run.proappstore.online/']);
  });

  it('sends BURST overlapping requests per root and reports every 5xx, 4xx or failed fetch', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      if (url.startsWith('https://run.')) return new Response('', { status: 500 });
      if (url.startsWith('https://crm.')) throw new TypeError('network');
      if (url.startsWith('https://ski.')) return new Response('', { status: 404 });
      return new Response('ok');
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const problems = await burstProblems(['https://run.proappstore.online/', 'https://crm.proappstore.online/', 'https://ski.proappstore.online/', 'https://meet.proappstore.online/'], fetchImpl);
    expect(peak).toBe(BURST);
    expect(fetchImpl).toHaveBeenCalledTimes(4 * BURST);
    expect(problems).toEqual([
      `https://run.proappstore.online/: ${BURST}/${BURST} failed (${Array(BURST).fill('500').join(', ')})`,
      `https://crm.proappstore.online/: ${BURST}/${BURST} failed (${Array(BURST).fill('fetch failed (TypeError)').join(', ')})`,
      `https://ski.proappstore.online/: ${BURST}/${BURST} failed (${Array(BURST).fill('404').join(', ')})`,
    ]);
  });

  it('deploy-host.yml runs the burst after deploying and rolls back when it fails', () => {
    const yml = readFileSync(join(import.meta.dirname, '..', '.github', 'workflows', 'deploy-host.yml'), 'utf8');
    const deploy = yml.indexOf('run: pnpm exec wrangler deploy');
    const burst = yml.indexOf('run: node scripts/smoke-host-burst.mjs');
    const rollback = yml.indexOf('pnpm exec wrangler rollback');
    expect(deploy).toBeGreaterThan(0);
    expect(burst).toBeGreaterThan(deploy);
    expect(rollback).toBeGreaterThan(burst);
    expect(yml).toContain("if: failure() && steps.burst.outcome == 'failure'");
  });
});
