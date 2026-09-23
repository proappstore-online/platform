import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TEMPLATE_ID, TEMPLATE_CATALOGUE, TEMPLATE_REV_RE, getTemplate, selectTemplate, templateCatalogueJson,
} from './template-catalogue.js';

/**
 * #178 — the approved-template catalogue and its selection contract.
 * Invariants: ids stable/unique, exactly one approved default, reviewed
 * revisions are full commit ids, known deviations are real standard clauses,
 * and the published docs copy never drifts from this module.
 */
const ROOT = resolve(__dirname, '../../..');

describe('template catalogue', () => {
  it('has unique ids and repos, and exactly one default which is approved', () => {
    expect(new Set(TEMPLATE_CATALOGUE.map((t) => t.id)).size).toBe(TEMPLATE_CATALOGUE.length);
    expect(new Set(TEMPLATE_CATALOGUE.map((t) => t.repo)).size).toBe(TEMPLATE_CATALOGUE.length);
    const defaults = TEMPLATE_CATALOGUE.filter((t) => t.default);
    expect(defaults).toHaveLength(1);
    expect(defaults[0]!.id).toBe(DEFAULT_TEMPLATE_ID);
    expect(defaults[0]!.status).toBe('approved');
  });

  it('every entry is well-formed: org repo, full source commit, dated review, deviations are clause ids', () => {
    for (const t of TEMPLATE_CATALOGUE) {
      expect(t.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(t.repo).toMatch(/^proappstore-online\/[A-Za-z0-9_.-]+$/);
      expect(t.release.source_commit).toMatch(/^[0-9a-f]{40}$/);
      expect(t.security_compliance.reviewed_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      for (const d of t.security_compliance.known_deviations) expect(d).toMatch(/^PAS-(STACK|AUTH|DATA|INT|UI|OPS)-\d{3}$/);
      if (t.status === 'deprecated' || t.status === 'withdrawn') expect(t.deprecation, `${t.id} needs a deprecation record`).not.toBeNull();
      if (t.status === 'approved') expect(t.deprecation).toBeNull();
    }
  });

  it('known deviations cite clauses that exist in the published standard', () => {
    const std = JSON.parse(readFileSync(resolve(ROOT, 'docs/standard/standard.json'), 'utf8')) as { clauses: { id: string }[] };
    const ids = new Set(std.clauses.map((c) => c.id));
    for (const t of TEMPLATE_CATALOGUE) for (const d of t.security_compliance.known_deviations) expect(ids.has(d), `${t.id} → ${d}`).toBe(true);
  });

  it('getTemplate resolves by id, repo, repo name, and falls back to the default', () => {
    expect(getTemplate('template-app')?.id).toBe('template-app');
    expect(getTemplate('proappstore-online/template-app')?.id).toBe('template-app');
    expect(getTemplate(undefined)?.id).toBe(DEFAULT_TEMPLATE_ID);
    expect(getTemplate('nope')).toBeUndefined();
  });

  it('selection contract: default when omitted, approved proceeds, unknown refused with the approved list', () => {
    expect(selectTemplate(undefined)).toMatchObject({ ok: true, warnings: [], template: { id: DEFAULT_TEMPLATE_ID } });
    expect(selectTemplate('template-app').ok).toBe(true);
    const bad = selectTemplate('evil-template');
    expect(bad.ok).toBe(false);
    expect(bad.reason).toContain('unknown template "evil-template"');
    expect(bad.reason).toContain('template-app');
    expect(bad.approved).toEqual(['template-app']);
  });

  it('selection contract: an explicit override admits an unknown template with a recorded warning', () => {
    const over = selectTemplate('evil-template', { allowUnapproved: true });
    expect(over.ok).toBe(true);
    expect(over.template).toBeUndefined();
    expect(over.warnings[0]).toContain('not in the approved catalogue');
    // without an id there is nothing to override — the default still applies
    expect(selectTemplate(undefined, { allowUnapproved: true }).template?.id).toBe(DEFAULT_TEMPLATE_ID);
  });

  it('accepts git object ids only as template revisions', () => {
    expect(TEMPLATE_REV_RE.test('d8c2e08')).toBe(true);
    expect(TEMPLATE_REV_RE.test('d8c2e08f32b8e30847b27c7092fd4b0e64341d2f')).toBe(true);
    expect(TEMPLATE_REV_RE.test('main')).toBe(false);
    expect(TEMPLATE_REV_RE.test('')).toBe(false);
  });

  it('docs/templates/catalogue.json is the published copy of this module (golden)', () => {
    const published = readFileSync(resolve(ROOT, 'docs/templates/catalogue.json'), 'utf8');
    expect(published, 'run: node --experimental-strip-types scripts/build-template-catalogue.mjs').toBe(JSON.stringify(templateCatalogueJson(), null, 2) + '\n');
  });
});
