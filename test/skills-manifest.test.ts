import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

/**
 * Release gate for the skill bundles (#176): the committed skills/index.json
 * and docs/skills/evaluations.md must be exactly what the generator produces
 * from the bundles, and every bundle must pass its validation.
 */
const ROOT = resolve(__dirname, '..');

describe('skills release gate', () => {
  it('refuses to generate a release with a skill targeting a different standard', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'pas-skills-version-'));
    try {
      for (const dir of ['scripts', 'docs/standard', 'docs/skills']) mkdirSync(join(fixture, dir), { recursive: true });
      for (const path of ['skills', '.claude-plugin', 'marketplace.json', 'scripts/build-skills-manifest.mjs', 'docs/standard/standard.json', 'docs/skills/evaluations.md']) {
        cpSync(join(ROOT, path), join(fixture, path), { recursive: true });
      }
      const skill = join(fixture, 'skills/audit-proappstore-app/SKILL.md');
      writeFileSync(skill, readFileSync(skill, 'utf8').replace(/standard-version: "[^"]+"/, 'standard-version: "0.0"'));
      // Generation itself must refuse the mismatch; a drift-only --check would
      // allow an incoherent manifest to be regenerated and then pass.
      const result = spawnSync(process.execPath, [join(fixture, 'scripts/build-skills-manifest.mjs')], { cwd: fixture, encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('audit-proappstore-app: metadata.standard-version "0.0" differs from current standard');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

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
