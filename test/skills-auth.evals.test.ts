import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Content evaluations for the proappstore-auth-sessions-roles skill (#173).
 * The skill is advisory and read-only, so its correctness is in its reference
 * files: every anti-pattern #173 names must be detectable and remediable from
 * them with real SDK surfaces and active AUTH clauses; every scenario in
 * evals/cases.json must be answerable; and nothing the skill says may name an
 * SDK module or method, recipe or sdk_reference feature that does not exist.
 */
const ROOT = resolve(__dirname, '..');
const SKILL = join(ROOT, 'skills', 'proappstore-auth-sessions-roles');
const read = (...p: string[]) => readFileSync(join(SKILL, ...p), 'utf8');

const skillMd = read('SKILL.md');
const tables = read('references', 'decision-tables.md');
const antiPatterns = read('references', 'anti-patterns.md');
const unsupported = read('references', 'unsupported-requirements.md');
const examples = read('references', 'worked-examples.md');
const negatives = read('references', 'negative-cases.md');
const allText = [skillMd, tables, antiPatterns, unsupported, examples, negatives, read('references', 'output-template.md')].join('\n');

interface Case {
  id: string; class: string; blocker?: string; anti_pattern?: string; title: string; requirements: string;
  expect: { surfaces?: string[]; clauses?: string[]; unsupported?: string[]; rejected?: string[]; recipes?: string[]; absent_methods?: string[]; feature?: string };
}
const cases = (JSON.parse(read('evals', 'cases.json')) as { cases: Case[] }).cases;

const SDK_SRC = join(ROOT, 'packages/sdk/src');
const SDK_MODULES = new Set(
  [...readFileSync(join(SDK_SRC, 'index.ts'), 'utf8').matchAll(/^\s+readonly ([a-z]+):/gm)].map((m) => m[1]!),
);
/** Does `app.<mod>.<member>` exist: a method, getter or property on the module's class. */
function sdkHas(mod: string, member: string): boolean {
  const file = join(SDK_SRC, `${mod}.ts`);
  if (!existsSync(file)) return false;
  const src = readFileSync(file, 'utf8');
  return new RegExp(`^\\s+(?:async\\s+)?(?:get\\s+)?${member}\\s*[(:<]`, 'm').test(src);
}
const RECIPES = new Set(
  [...readFileSync(join(ROOT, 'packages/agent-teams/src/recipes.ts'), 'utf8').matchAll(/^  ['"]?([a-z]+(?:-[a-z]+)+)['"]?:\s*\{/gm)].map((m) => m[1]!),
);
const UI_EXPORTS = new Set(
  ['hooks.ts', 'provider.tsx', 'shell.tsx', 'ui.tsx', 'ui-gate.tsx', 'ui-profile-menu.tsx', 'ui-pro-components.tsx', 'ui-primitives.tsx']
    .flatMap((f) => [...readFileSync(join(SDK_SRC, f), 'utf8').matchAll(/export (?:function|const) ([A-Za-z]+)/g)].map((m) => m[1]!)),
);
const standard = JSON.parse(readFileSync(join(ROOT, 'docs/standard/standard.json'), 'utf8')) as { clauses: Array<{ id: string; chapter: string; status: string; url: string }> };
const CLAUSES = new Map(standard.clauses.map((c) => [c.id, c]));

/** The anti-patterns #173 requires the workflow to detect and remediate. */
const REQUIRED_ANTI_PATTERNS = [
  'Session in storage', '`app.auth.token` coupling', 'Home-grown sign-in or session tables',
  'Membership-only privileged gates', 'Unsafe return URLs', 'Incomplete sign-out', 'Missing negative authorization tests',
];

describe('proappstore-auth-sessions-roles: no fabricated APIs', () => {
  it('every app.<module> it names is a real SDK module', () => {
    const named = new Set([...allText.matchAll(/\bapp\.([a-z]+)\b/g)].map((m) => m[1]!));
    expect(named.size).toBeGreaterThan(5);
    for (const m of named) expect(SDK_MODULES.has(m), `app.${m}`).toBe(true);
  });

  it('every app.<module>.<member> it names exists in the SDK source (except the deliberately absent ones in the blocker cases)', () => {
    const absent = new Set(cases.flatMap((c) => (c.expect.absent_methods ?? []).map((m) => `${c.expect.feature}.${m}`)));
    const named = new Set([...allText.matchAll(/\bapp\.([a-z]+)\.([A-Za-z]+)\b/g)].map((m) => `${m[1]}.${m[2]}`).filter((n) => !absent.has(n)));
    expect(named.size).toBeGreaterThan(15);
    for (const n of named) {
      const [mod, member] = n.split('.') as [string, string];
      expect(sdkHas(mod, member), `app.${n} is not on the SDK`).toBe(true);
    }
  });

  it('every SDK UI component or hook it names is exported', () => {
    const named = new Set([...allText.matchAll(/`((?:use[A-Z]|Pro[A-Z]|SignIn|Gate|Profile)[A-Za-z]+)`/g)].map((m) => m[1]!));
    expect(named.size).toBeGreaterThan(3);
    for (const n of named) expect(UI_EXPORTS.has(n), `${n} is not exported by the SDK UI`).toBe(true);
  });

  it('every recipe it names is one the recipe tool serves', () => {
    const named = new Set([...allText.matchAll(/[Rr]ecipe[s]?[: ]+`([a-z-]+)`/g)].map((m) => m[1]!));
    expect(named.size).toBeGreaterThan(0);
    for (const r of named) expect(RECIPES.has(r), r).toBe(true);
  });

  it('every sdk_reference feature it names is in the tool enum', () => {
    const src = readFileSync(join(ROOT, 'packages/mcp/src/platform-tools.ts'), 'utf8');
    const features = new Set([...(/feature:\s*z\.enum\(\[([\s\S]*?)\]\)/.exec(src)![1]!).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!));
    const named = [...skillMd.matchAll(/feature[s]? `([a-z_]+)`(?:(?:, | \/ |, and )`([a-z_]+)`)*/g)].flatMap((m) => m[0].match(/`([a-z_]+)`/g)!.map((x) => x.slice(1, -1)));
    expect(named.length).toBeGreaterThan(2);
    for (const f of named) expect(features.has(f), `feature ${f}`).toBe(true);
  });

  it('cites only active clauses, each linked at its published URL, and covers every AUTH clause', () => {
    const cited = new Set([...allText.matchAll(/PAS-[A-Z]+-\d{3}/g)].map((m) => m[0]));
    for (const id of cited) {
      const c = CLAUSES.get(id);
      expect(c, `${id} is not in the standard`).toBeTruthy();
      expect(c!.status, id).toBe('active');
      expect(allText, `${id} never linked to ${c!.url}`).toContain(`[${id}](${c!.url})`);
    }
    for (const c of standard.clauses.filter((c) => c.chapter === 'AUTH' && c.status === 'active')) expect(cited.has(c.id), `${c.id} (${c.chapter}) is never cited`).toBe(true);
  });
});

describe('proappstore-auth-sessions-roles: security content', () => {
  it('names every anti-pattern #173 requires, each with a detect, clause, remediation and proof', () => {
    for (const ap of REQUIRED_ANTI_PATTERNS) {
      const idx = antiPatterns.indexOf(`## `) >= 0 ? antiPatterns.indexOf(ap) : -1;
      expect(idx, `anti-pattern "${ap}" missing`).toBeGreaterThan(-1);
      const section = antiPatterns.slice(idx).split(/\n## /)[0]!;
      for (const part of ['**Detect:**', '**Clause:**', '**Remediate:**', '**Prove:**']) expect(section, `${ap}: ${part}`).toContain(part);
      expect(section).toMatch(/PAS-[A-Z]+-\d{3}/);
    }
  });

  it('treats the UI as UX and the manifest + SQL as the boundary', () => {
    expect(skillMd).toMatch(/UI guard[^.]*never the gate/i);
    expect(antiPatterns).toMatch(/## 8\. UI guard as the boundary/);
    expect(tables).toMatch(/Subscription gates are not permissions/);
    for (const key of ['requires_auth: true', 'app_roles', ':__user_id']) expect(tables).toContain(key);
  });

  it('distinguishes platform, team and app roles and forbids team/platform roles for app features', () => {
    expect(skillMd).toMatch(/Three role systems/);
    expect(tables).toMatch(/team or platform roles as app permissions/);
    expect(negatives).toMatch(/## Team role used as an app permission/);
  });

  it('keeps PAS-AUTH-020 human: never marks live verification as passed', () => {
    expect(skillMd).toMatch(/never report those as passed yourself|never mark it passed/);
    expect(negatives).toMatch(/Blocker: \*\*manual-verification\*\*/);
  });

  it('unsupported requirements each carry an interim pattern and a clause, and never a substitute', () => {
    const rows = unsupported.split('\n').filter((l) => /^\| [A-Z]/.test(l) && !/^\| Requirement/.test(l));
    expect(rows.length).toBeGreaterThanOrEqual(8);
    for (const r of rows) {
      const cells = r.split('|').map((c) => c.trim());
      expect(cells[3], `${cells[1]}: no interim pattern`).toBeTruthy();
      expect(cells[4], `${cells[1]}: no clause`).toMatch(/PAS-[A-Z]+-\d{3}/);
      expect(cells[3]).not.toMatch(/Firebase|Auth0|Clerk|Supabase|NextAuth|own cookie|refresh token/i);
    }
  });
});

const exampleFor = (id: string) => {
  const i = examples.indexOf(`## ${id}`);
  expect(i, `no worked example ## ${id}`).toBeGreaterThan(-1);
  return examples.slice(i).split(/\n## /)[0]!;
};

describe.each(cases.filter((c) => c.class === 'scenario'))('scenario $id', (c) => {
  it('has a worked example that names its anti-pattern, if any, and says what is unsupported', () => {
    const ex = exampleFor(c.id);
    if (c.anti_pattern) {
      expect(REQUIRED_ANTI_PATTERNS, `${c.anti_pattern} is not a required anti-pattern`).toContain(c.anti_pattern);
      expect(ex).toMatch(/Finding:/);
      expect(ex).toMatch(/Remediation:/);
      expect(ex).toMatch(/Prove:/);
    }
    expect(ex).toMatch(/Unsupported:/);
    if ((c.expect.unsupported ?? []).length === 0) expect(ex).toMatch(/Unsupported:\s*none/);
    for (const u of c.expect.unsupported ?? []) expect(unsupported, `unsupported table lacks "${u}"`).toContain(u);
  });

  it('recommends real SDK surfaces that the example uses', () => {
    const ex = exampleFor(c.id);
    for (const s of c.expect.surfaces ?? []) {
      const [, mod, member] = /^app\.([a-z]+)\.([A-Za-z]+)$/.exec(s)!;
      expect(sdkHas(mod!, member!), s).toBe(true);
      expect(ex, `${s} not in example`).toContain(s.replace(/^app\./, ''));
    }
  });

  it('cites active clauses that the references and the example both cite', () => {
    expect((c.expect.clauses ?? []).length).toBeGreaterThan(0);
    const ex = exampleFor(c.id);
    for (const id of c.expect.clauses ?? []) {
      expect(CLAUSES.get(id)?.status, id).toBe('active');
      expect(tables + antiPatterns + unsupported, `${id} not in references`).toContain(id);
      expect(ex, `${id} not in example`).toContain(id);
    }
  });

  it('lists the rejected substitutes as "do not use"', () => {
    for (const r of c.expect.rejected ?? []) expect(tables + unsupported + antiPatterns, `"${r}" never rejected`).toContain(r);
  });

  it('points at documented recipes', () => {
    const ex = exampleFor(c.id);
    for (const r of c.expect.recipes ?? []) {
      expect(RECIPES.has(r), r).toBe(true);
      expect(ex).toContain(`\`${r}\``);
    }
  });
});

describe.each(cases.filter((c) => c.class === 'blocker'))('blocker $id', (c) => {
  it('is described in negative-cases.md with its class and its expectations hold', () => {
    expect(negatives).toMatch(new RegExp(`Blocker[^*]{0,40}\\*\\*${c.blocker}`));
    for (const u of c.expect.unsupported ?? []) expect(unsupported).toContain(u);
    for (const id of c.expect.clauses ?? []) {
      expect(CLAUSES.get(id)?.status, id).toBe('active');
      expect(negatives + unsupported, `${id} not cited for the blocker`).toContain(id);
    }
    for (const m of c.expect.absent_methods ?? []) {
      expect(sdkHas(c.expect.feature!, m), `app.${c.expect.feature}.${m} unexpectedly exists`).toBe(false);
      expect(negatives).toContain(`app.${c.expect.feature}.${m}()`);
    }
  });
});
