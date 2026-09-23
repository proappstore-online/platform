import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Release gate for the skill bundles (#176): the committed skills/index.json
 * and docs/skills/evaluations.md must be exactly what the generator produces
 * from the bundles, and every bundle must pass its validation.
 */
const ROOT = resolve(__dirname, '..');

describe('skills release gate', () => {
  it('scripts/build-skills-manifest.mjs --check passes (bundles valid, manifest and summary up to date)', () => {
    const out = execFileSync('node', [join(ROOT, 'scripts/build-skills-manifest.mjs'), '--check'], { cwd: ROOT, encoding: 'utf8' });
    expect(out).toMatch(/✓ \d+ skill bundle\(s\) valid/);
  });

  it('skills/index.json lists every skill directory with its digest, allow-list and evaluation counts', () => {
    const index = JSON.parse(readFileSync(join(ROOT, 'skills/index.json'), 'utf8')) as { standard_version: string; skills: Array<{ name: string; version: string; digest: string; files: Array<{ path: string; sha256: string }>; 'allowed-tools': string[]; evaluations: { cases: number; trigger_prompts: { positive: number; negative: number } } }> };
    const standard = JSON.parse(readFileSync(join(ROOT, 'docs/standard/standard.json'), 'utf8')) as { standard: { version: string } };
    expect(index.standard_version).toBe(standard.standard.version);
    expect(index.skills.length).toBeGreaterThanOrEqual(6);
    for (const s of index.skills) {
      expect(s.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(s.files.some((f) => f.path === 'SKILL.md')).toBe(true);
      for (const f of s.files) expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(s['allowed-tools'].length).toBeGreaterThan(0);
      expect(s.evaluations.cases).toBeGreaterThan(0);
      expect(s.evaluations.trigger_prompts.positive).toBeGreaterThanOrEqual(4);
      expect(s.evaluations.trigger_prompts.negative).toBeGreaterThanOrEqual(4);
    }
  });
});
