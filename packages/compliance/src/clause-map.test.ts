import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as compliance from './index.js';
import { CHECKS, annotate, annotateByName, citationsFor, clauseUrl, complianceMap } from './clause-map.js';

/**
 * #166 — every compliance check has a stable id mapped to real, public clauses
 * of the Application Standard, and the published copy of the mapping
 * (docs/standard/compliance-checks.json) never drifts from the code.
 */
const ROOT = resolve(__dirname, '../../..');
const standard = JSON.parse(readFileSync(resolve(ROOT, 'docs/standard/standard.json'), 'utf8')) as {
  standard: { version: string };
  clauses: Array<{ id: string; url: string; status: string; verification: string; enforcement: string }>;
};
const clausesById = new Map(standard.clauses.map((c) => [c.id, c]));
const ID_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

describe('compliance → standard clause map', () => {
  it('every source-side runner id has a mapping, and vice versa', () => {
    const mapped = new Set(CHECKS.filter((m) => !m.live).map((m) => m.id));
    expect([...mapped].sort()).toEqual([...compliance.SOURCE_CHECK_IDS].sort());
  });

  it('every exported check function is represented exactly once', () => {
    const fns = Object.keys(compliance).filter((k) => /^check[A-Z]/.test(k) && !k.endsWith('Live'));
    expect(compliance.SOURCE_CHECK_IDS).toHaveLength(fns.length);
    expect(new Set(compliance.SOURCE_CHECK_IDS).size).toBe(fns.length);
  });

  it('ids are stable kebab-case and unique; names are unique', () => {
    for (const m of CHECKS) expect(m.id, m.name).toMatch(ID_RE);
    expect(new Set(CHECKS.map((m) => m.id)).size).toBe(CHECKS.length);
    expect(new Set(CHECKS.map((m) => m.name)).size).toBe(CHECKS.length);
  });

  it('every mapped clause exists in the published standard and is active', () => {
    for (const m of CHECKS) {
      expect(m.clauses.length, `${m.id} maps to no clause`).toBeGreaterThan(0);
      for (const id of m.clauses) {
        const clause = clausesById.get(id);
        expect(clause, `${m.id} → ${id} is not a published clause`).toBeDefined();
        expect(clause!.status, `${m.id} → ${id} is withdrawn`).toBe('active');
      }
    }
  });

  it('citation URLs equal the clause URLs published in standard.json', () => {
    for (const m of CHECKS) {
      for (const c of citationsFor(m)) {
        expect(c.url).toBe(clausesById.get(c.clauseId)!.url);
        expect(c.url).toMatch(/^https:\/\/docs\.proappstore\.online\/standard\/[a-z-]+\/#pas-[a-z]+-\d{3}$/);
      }
    }
    expect(() => clauseUrl('PAS-NOPE-001')).toThrow();
  });

  it('a "full" automation claim is only made where the clause names automated enforcement', () => {
    for (const m of CHECKS.filter((x) => x.automation === 'full')) {
      const enforced = m.clauses.some((id) => clausesById.get(id)!.enforcement === 'automated');
      expect(enforced, `${m.id} claims full automation but none of ${m.clauses.join(', ')} declares automated enforcement`).toBe(true);
    }
  });

  it('the live audit names are all mapped', () => {
    for (const name of ['Reachable', 'Brand fonts (live)', 'Bundle size (live)', 'PWA manifest (live)', 'No tracking SDKs (live)', 'No unsafe 100vh (live)']) {
      expect(annotateByName({ name, status: 'pass', detail: 'x' }).checkId, name).toBeDefined();
    }
  });

  it('annotate adds id, citations, automation and evidence without touching the original fields', () => {
    const meta = CHECKS.find((m) => m.id === 'no-tracking')!;
    const raw = { name: 'No tracking SDKs', status: 'fail' as const, detail: 'gtag in web/index.html', suggestions: ['remove it'] };
    const out = annotate(raw, meta);
    expect(out).toMatchObject({ ...raw, checkId: 'no-tracking', automation: 'partial', evidence: { class: 'source', detail: raw.detail } });
    expect(out.citations![0]).toEqual({ clauseId: 'PAS-UI-022', url: 'https://docs.proappstore.online/standard/ui/#pas-ui-022' });
  });

  it('runChecksFromFiles decorates every result', async () => {
    const results = await compliance.runChecksFromFiles(new Map());
    for (const r of results) {
      expect(r.checkId, r.name).toBeDefined();
      expect(r.citations!.length, r.name).toBeGreaterThan(0);
      expect(r.evidence!.detail).toBe(r.detail);
    }
  });

  it('docs/standard/compliance-checks.json is the published copy of this map (golden)', () => {
    const published = readFileSync(resolve(ROOT, 'docs/standard/compliance-checks.json'), 'utf8');
    const expected = JSON.stringify({ ...complianceMap(), standard_version: standard.standard.version }, null, 2) + '\n';
    expect(published, 'run: node scripts/build-compliance-map.mjs').toBe(expected);
  });
});
