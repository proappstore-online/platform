import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The template-archetype investigation (#179) publishes an evidence matrix
 * and a recommendation. These tests keep the published artefact honest: the
 * matrix is well-formed, every clause it cites exists and is active, every
 * recommended archetype has a ticket and evidence apps that are in the
 * matrix, no more than three archetypes are recommended, no recommended id
 * collides with a catalogue template, and the narrative page names every
 * archetype and every recommended ticket.
 */
const DOCS = resolve(__dirname, '../docs');
const matrix = JSON.parse(readFileSync(join(DOCS, 'templates/archetype-evidence.json'), 'utf8')) as {
  investigated_at: string; standard_version: string;
  apps: Array<{ id: string; purpose: string; reuse: 'yes' | 'with-fixes' | 'no'; reuse_reason: string; archetype: string; registered_actions: number; migrations: number; tables: number; services: string[]; auth_mode: string; compliance: string | null; debt: Record<string, number> }>;
  archetypes: Array<{ id: string; name: string; recommended: boolean; ticket: number | null; evidence_apps: string[]; scores: Record<string, number>; clauses: string[]; core_tables: string[]; core_actions: string[]; required_services: string[]; reason_not_recommended?: string }>;
};
const narrative = readFileSync(join(DOCS, 'templates/archetypes.md'), 'utf8');
const standard = JSON.parse(readFileSync(join(DOCS, 'standard/standard.json'), 'utf8')) as { standard: { version: string }; clauses: Array<{ id: string; status: string }> };
const CLAUSES = new Map(standard.clauses.map((c) => [c.id, c.status]));
const catalogue = JSON.parse(readFileSync(join(DOCS, 'templates/catalogue.json'), 'utf8')) as { templates: Array<{ id: string }> };
const SDK_MODULES = new Set([...readFileSync(resolve(__dirname, '../packages/sdk/src/index.ts'), 'utf8').matchAll(/^\s+readonly ([a-z]+):/gm)].map((m) => m[1]!));

describe('template archetype evidence (#179)', () => {
  it('matrix is well-formed: unique app ids, valid reuse verdicts with reasons, archetype references resolve', () => {
    expect(matrix.standard_version).toBe(standard.standard.version);
    expect(matrix.investigated_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Set(matrix.apps.map((a) => a.id)).size).toBe(matrix.apps.length);
    expect(matrix.apps.length).toBeGreaterThanOrEqual(20);
    const archetypeIds = new Set([...matrix.archetypes.map((x) => x.id), 'membership', 'workspace', 'marketplace', 'none']);
    for (const a of matrix.apps) {
      expect(['yes', 'with-fixes', 'no'], a.id).toContain(a.reuse);
      expect(a.reuse_reason.length, `${a.id} reuse reason`).toBeGreaterThan(5);
      expect(archetypeIds.has(a.archetype), `${a.id} archetype ${a.archetype}`).toBe(true);
      for (const s of a.services) expect(SDK_MODULES.has(s), `${a.id} service ${s}`).toBe(true);
      expect(a.registered_actions).toBeGreaterThanOrEqual(0);
      expect(['platform-cookie', 'legacy-bearer', 'none', 'no-initPro']).toContain(a.auth_mode);
    }
  });

  it('at most three archetypes are recommended, each with a ticket, evidence apps in the matrix, scores and active clauses', () => {
    const rec = matrix.archetypes.filter((x) => x.recommended);
    expect(rec.length).toBeGreaterThanOrEqual(1);
    expect(rec.length).toBeLessThanOrEqual(3);
    const appIds = new Set(matrix.apps.map((a) => a.id));
    for (const x of matrix.archetypes) {
      expect(x.evidence_apps.length, x.id).toBeGreaterThanOrEqual(2);
      for (const a of x.evidence_apps) expect(appIds.has(a), `${x.id} evidence app ${a}`).toBe(true);
      for (const k of ['demand', 'genericity', 'configurability', 'maintenance_cost', 'standard_conformity']) { expect(x.scores[k], `${x.id} score ${k}`).toBeGreaterThanOrEqual(1); expect(x.scores[k]).toBeLessThanOrEqual(5); }
      for (const c of x.clauses) expect(CLAUSES.get(c), `${x.id} cites ${c}`).toBe('active');
      if (x.recommended) {
        expect(x.ticket, `${x.id} ticket`).toBeGreaterThan(0);
        expect(x.core_tables.length).toBeGreaterThan(2);
        expect(x.core_actions.length).toBeGreaterThan(2);
        expect(x.required_services).toContain('auth');
        expect(x.id).toMatch(/^template-[a-z]+$/);
        expect(catalogue.templates.some((t) => t.id === x.id), `${x.id} collides with a catalogue template`).toBe(false);
        // every recommended archetype has at least two evidence apps that are reusable (yes or with-fixes)
        expect(x.evidence_apps.filter((a) => matrix.apps.find((m) => m.id === a)!.reuse !== 'no').length, `${x.id} reusable sources`).toBeGreaterThanOrEqual(2);
      } else {
        expect(x.reason_not_recommended, `${x.id} needs a reason`).toBeTruthy();
      }
    }
  });

  it('the narrative names every archetype, every recommended ticket, every app, and links the evidence file', () => {
    for (const x of matrix.archetypes) {
      expect(narrative).toContain(`\`${x.id}\``);
      if (x.recommended) expect(narrative).toContain(`#${x.ticket}`);
    }
    for (const a of matrix.apps) expect(narrative, a.id).toContain(`\`${a.id}\``);
    expect(narrative).toContain('archetype-evidence.json');
    expect(narrative).toMatch(/## Debt that must not be copied/);
    expect(narrative).toMatch(/## Legality of reuse/);
    for (const m of narrative.matchAll(/\]\((\.\.?\/[^)#\s]+)/g)) expect(existsSync(resolve(join(DOCS, 'templates'), m[1]!)), m[1]).toBe(true);
    for (const m of narrative.matchAll(/PAS-[A-Z]+-\d{3}/g)) expect(CLAUSES.get(m[0]), m[0]).toBe('active');
  });
});
