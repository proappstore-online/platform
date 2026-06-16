import { describe, expect, it } from 'vitest';
import { seedFiles } from './template-seed.ts';

/**
 * The platform OWNS CI: handleAgentDeploy (admin/src/publish.ts) strips every
 * .github/workflows/* from the bundle and injects the single canonical
 * deployWorkflowYaml() at deploy time. Seeding a workflow here is therefore dead
 * code — and historically WRONG (the old seed deployed to Cloudflare Pages, the
 * abandoned Path-A model). This test locks that in: the seed must never emit a
 * workflow file again, so a future edit can't silently reintroduce drift.
 */
describe('seedFiles — platform owns CI, seed carries no workflow', () => {
  const files = seedFiles('demo-app');

  it('seeds NO .github/workflows/* files', () => {
    const workflows = [...files.keys()].filter((p) => /^\.github\/workflows\//.test(p));
    expect(workflows).toEqual([]);
  });

  it('still seeds the real app scaffold (package.json, vite, index.html, src)', () => {
    // Sanity: removing the workflows must not have gutted the scaffold.
    expect(files.has('package.json')).toBe(true);
    expect(files.has('index.html')).toBe(true);
    expect([...files.keys()].some((p) => p.startsWith('src/'))).toBe(true);
  });

  it('never references Cloudflare Pages (Path B / R2 only)', () => {
    // The removed seed deployed via `wrangler pages deploy`. Guard against any
    // file reintroducing the abandoned Path-A model.
    for (const content of files.values()) {
      expect(content).not.toContain('pages deploy');
    }
  });
});
