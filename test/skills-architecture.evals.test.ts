import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Content evaluations for the choose-proappstore-architecture skill (#171).
 * The skill is advisory and read-only, so its correctness is in its reference
 * tables: every scenario in evals/cases.json must be answerable from them with
 * real primitives, active standard clauses, honest "unsupported" entries and
 * documented recipes — and nothing the skill says may name an SDK module,
 * recipe or sdk_reference feature that does not exist.
 */
const ROOT = resolve(__dirname, '..');
const SKILL = join(ROOT, 'skills', 'choose-proappstore-architecture');
const read = (...p: string[]) => readFileSync(join(SKILL, ...p), 'utf8');

const skillMd = read('SKILL.md');
const tables = read('references', 'decision-tables.md');
const unsupported = read('references', 'unsupported-requirements.md');
const examples = read('references', 'worked-examples.md');
const negatives = read('references', 'negative-cases.md');
const allText = [skillMd, tables, unsupported, examples, negatives, read('references', 'output-template.md')].join('\n');

interface Case {
  id: string; class: string; blocker?: string; title: string; requirements: string;
  expect: { primitives?: string[]; clauses?: string[]; unsupported?: string[]; rejected?: string[]; recipes?: string[]; issue?: string; absent_methods?: string[]; feature?: string; docs?: string[] };
}
const cases = (JSON.parse(read('evals', 'cases.json')) as { cases: Case[] }).cases;

/** Real SDK modules: the `readonly x: T` members of ProAppStore in packages/sdk/src/index.ts. */
const SDK_MODULES = new Set(
  [...readFileSync(join(ROOT, 'packages/sdk/src/index.ts'), 'utf8').matchAll(/^\s+readonly ([a-z]+):/gm)].map((m) => m[1]!),
);
/** Documented recipe names: the keys of RECIPES in agent-teams (what the `recipe` tool serves). */
const RECIPES = new Set(
  [...readFileSync(join(ROOT, 'packages/agent-teams/src/recipes.ts'), 'utf8').matchAll(/^  ['"]?([a-z]+(?:-[a-z]+)+)['"]?:\s*\{/gm)].map((m) => m[1]!),
);
const standard = JSON.parse(readFileSync(join(ROOT, 'docs/standard/standard.json'), 'utf8')) as { clauses: Array<{ id: string; status: string; url: string }> };
const CLAUSES = new Map(standard.clauses.map((c) => [c.id, c]));

describe('choose-proappstore-architecture: no fabricated APIs', () => {
  it('every app.<module> the skill names is a real SDK module', () => {
    const named = new Set([...allText.matchAll(/\bapp\.([a-z]+)\b/g)].map((m) => m[1]!));
    expect(named.size).toBeGreaterThan(10);
    for (const m of named) expect(SDK_MODULES.has(m), `app.${m} is not an SDK module`).toBe(true);
  });

  it('the module list in SKILL.md is exactly the SDK surface', () => {
    const listed = new Set([...skillMd.matchAll(/`app\.([a-z]+)`/g)].map((m) => m[1]!));
    expect([...listed].sort()).toEqual([...SDK_MODULES].sort());
  });

  it('every recipe the skill names is one the recipe tool serves', () => {
    const named = new Set([...allText.matchAll(/`([a-z]+(?:-[a-z]+)+)`/g)].map((m) => m[1]!).filter((n) => !/^(create-proappstore-app|choose-proappstore-architecture|platform-cookie|mcp-app-tools|last-write-wins)$/.test(n)));
    expect(named.size).toBeGreaterThan(5);
    for (const r of named) expect(RECIPES.has(r), `recipe \`${r}\` is not served by the recipe tool`).toBe(true);
  });

  it('every sdk_reference feature the skill names is in the tool enum', () => {
    const src = readFileSync(join(ROOT, 'packages/mcp/src/platform-tools.ts'), 'utf8');
    const enumSrc = /feature:\s*z\.enum\(\[([\s\S]*?)\]\)/.exec(src)![1]!;
    const features = new Set([...enumSrc.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!));
    const line = /`sdk_reference` \(feature: ([^)]*)\)/.exec(skillMd.replace(/\n\s+/g, ' '))![1]!;
    const named = [...line.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]!);
    expect(named.length).toBeGreaterThan(10);
    for (const f of named) expect(features.has(f), `feature ${f}`).toBe(true);
  });

  it('every clause it cites exists, is active, and is linked at its published URL', () => {
    const cited = new Set([...allText.matchAll(/PAS-[A-Z]+-\d{3}/g)].map((m) => m[0]));
    expect(cited.size).toBeGreaterThan(30);
    for (const id of cited) {
      const c = CLAUSES.get(id);
      expect(c, `${id} is not in the standard`).toBeTruthy();
      expect(c!.status, `${id} is ${c!.status}`).toBe('active');
      expect(allText, `${id} is never linked to ${c!.url}`).toContain(`[${id}](${c!.url})`);
    }
  });

  it('the decision tables list rejected substitutes in a "Do not use" column and name the platform limits', () => {
    expect(tables).toMatch(/\| Do not use \|/);
    for (const limit of ['100 keys', '64 KB', '1 MB', '32 peers', 'no per-app room cap', '4 KB', '50 MB', '10 000 req']) expect(tables, `limit ${limit}`).toContain(limit);
  });

  it('unsupported requirements each carry an interim pattern and a citation, and never a substitute', () => {
    const rows = unsupported.split('\n').filter((l) => /^\| [A-Z]/.test(l) && !/^\| Requirement/.test(l));
    expect(rows.length).toBeGreaterThanOrEqual(10);
    for (const r of rows) {
      const cells = r.split('|').map((c) => c.trim());
      expect(cells[3], `${cells[1]}: no interim pattern`).toBeTruthy();
      expect(cells[4], `${cells[1]}: no citation`).toMatch(/PAS-[A-Z]+-\d{3}/);
      expect(cells[3], `${cells[1]}: interim pattern proposes a substitute`).not.toMatch(/Firebase|Supabase|Pusher|Auth0|Clerk|SendGrid|own Worker/i);
    }
    expect(unsupported).toMatch(/#123/);
    expect(unsupported).toMatch(/#148/);
  });
});

describe.each(cases.filter((c) => c.class === 'scenario'))('scenario $id', (c) => {
  it('has a worked example', () => {
    expect(examples).toMatch(new RegExp(`^## ${c.id}\\b`, 'm'));
  });

  it('recommends real primitives that the decision tables and the worked example both name', () => {
    const example = examples.slice(examples.indexOf(`## ${c.id}`)).split(/\n## /)[0]!;
    for (const p of c.expect.primitives ?? []) {
      expect(SDK_MODULES.has(p.replace(/^app\./, '')), p).toBe(true);
      expect(tables, `${p} missing from decision tables`).toContain(p);
      // Actions surface in examples as `app.actions` or as named actions / "actions".
      if (p !== 'app.actions') expect(example, `${p} missing from worked example`).toContain(p);
      else expect(example).toMatch(/\baction/);
    }
  });

  it('cites active clauses that the worked example also cites', () => {
    const example = examples.slice(examples.indexOf(`## ${c.id}`)).split(/\n## /)[0]!;
    expect((c.expect.clauses ?? []).length).toBeGreaterThan(0);
    for (const id of c.expect.clauses ?? []) {
      expect(CLAUSES.get(id)?.status, id).toBe('active');
      expect(tables + unsupported, `${id} not in references`).toContain(id);
      expect(example, `${id} not cited in the worked example`).toContain(id);
    }
  });

  it('names every unsupported requirement in the unsupported table and in the example', () => {
    const example = examples.slice(examples.indexOf(`## ${c.id}`)).split(/\n## /)[0]!;
    for (const u of c.expect.unsupported ?? []) {
      expect(unsupported, `unsupported table lacks "${u}"`).toContain(u);
      expect(example, `example ${c.id} does not say "Unsupported"`).toMatch(/Unsupported:/);
    }
    if ((c.expect.unsupported ?? []).length === 0) expect(example).toMatch(/Unsupported:\s*none/);
  });

  it('lists the rejected substitutes as "do not use"', () => {
    for (const r of c.expect.rejected ?? []) expect(tables + unsupported + examples, `"${r}" never rejected`).toContain(r);
  });

  it('points at documented recipes', () => {
    const example = examples.slice(examples.indexOf(`## ${c.id}`)).split(/\n## /)[0]!;
    for (const r of c.expect.recipes ?? []) {
      expect(RECIPES.has(r), r).toBe(true);
      expect(example, `recipe ${r} not in example`).toContain(`\`${r}\``);
    }
  });
});

describe.each(cases.filter((c) => c.class === 'blocker'))('blocker $id', (c) => {
  it('is described in negative-cases.md with its class', () => {
    expect(negatives).toMatch(new RegExp(`Blocker[^*]{0,40}\\*\\*${c.blocker}`));
  });

  it('its expectations hold against the references', () => {
    const e = c.expect;
    for (const u of e.unsupported ?? []) expect(unsupported).toContain(u);
    for (const id of e.clauses ?? []) expect(CLAUSES.get(id)?.status, id).toBe('active');
    for (const r of e.rejected ?? []) expect(tables + unsupported + negatives).toContain(r);
    if (e.issue) expect(unsupported).toContain(e.issue);
    if (e.absent_methods) {
      // The method must genuinely not exist on the SDK module, and the skill must say so.
      const mod = readFileSync(join(ROOT, 'packages/sdk/src', `${e.feature}.ts`), 'utf8');
      for (const m of e.absent_methods) {
        expect(mod).not.toMatch(new RegExp(`\\b${m}\\s*\\(`));
        expect(negatives).toContain(`app.${e.feature}.${m}()`);
      }
    }
    for (const d of e.docs ?? []) expect(existsSync(join(ROOT, 'docs', `${d}.md`)), d).toBe(true);
  });
});
