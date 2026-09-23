import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Content evaluations for the proappstore-data-migrations-actions skill (#175).
 * The skill is advisory and read-only, so its correctness is in its reference
 * files: every data anti-pattern #175 names (cross-tenant access, guessed
 * identifiers, replayable grants, unsafe writes, migration/action drift) must
 * be detectable and remediable from them with real SDK surfaces, real manifest
 * keys, real magic parameters and active DATA clauses; every scenario in
 * evals/cases.json must be answerable; the skill must never recommend raw
 * browser SQL or client-only authorization; and nothing it says may name an
 * SDK method, manifest key, recipe or sdk_reference feature that does not exist.
 */
const ROOT = resolve(__dirname, '..');
const SKILL = join(ROOT, 'skills', 'proappstore-data-migrations-actions');
const read = (...p: string[]) => readFileSync(join(SKILL, ...p), 'utf8');

const skillMd = read('SKILL.md');
const tables = read('references', 'decision-tables.md');
const antiPatterns = read('references', 'anti-patterns.md');
const unsupported = read('references', 'unsupported-requirements.md');
const examples = read('references', 'worked-examples.md');
const negatives = read('references', 'negative-cases.md');
const output = read('references', 'output-template.md');
const allText = [skillMd, tables, antiPatterns, unsupported, examples, negatives, output].join('\n');

interface Case {
  id: string; class: string; blocker?: string; anti_pattern?: string; title: string; requirements: string;
  expect: { surfaces?: string[]; manifest?: string[]; magic?: string[]; clauses?: string[]; unsupported?: string[]; rejected?: string[]; recipes?: string[]; issue?: string; absent_methods?: string[]; absent_keys?: string[]; feature?: string; docs?: string[] };
}
const cases = (JSON.parse(read('evals', 'cases.json')) as { cases: Case[] }).cases;

const SDK_SRC = join(ROOT, 'packages/sdk/src');
const SDK_MODULES = new Set(
  [...readFileSync(join(SDK_SRC, 'index.ts'), 'utf8').matchAll(/^\s+readonly ([a-z]+):/gm)].map((m) => m[1]!),
);
function sdkHas(mod: string, member: string): boolean {
  const file = join(SDK_SRC, `${mod}.ts`);
  if (!existsSync(file)) return false;
  return new RegExp(`^\\s+(?:async\\s+)?(?:get\\s+)?${member}\\s*[(:<]`, 'm').test(readFileSync(file, 'utf8'));
}
const RECIPES = new Set(
  [...readFileSync(join(ROOT, 'packages/agent-teams/src/recipes.ts'), 'utf8').matchAll(/^  ['"]?([a-z]+(?:-[a-z]+)+)['"]?:\s*\{/gm)].map((m) => m[1]!),
);
/** The manifest validator + executor: every manifest key the platform understands appears here as a literal. */
const MANIFEST_SRC = readFileSync(join(ROOT, 'packages/backend/src/routes/tools.ts'), 'utf8') + readFileSync(join(ROOT, 'packages/backend/src/routes/actions.ts'), 'utf8');
/** Manifest keys the skill may name (top-level, `auth.*`, and per-param). */
const MANIFEST_KEY_RE = /`(?:auth\.)?(requires_auth|app_roles|platform_roles|caller_unscoped|required|statements|operation|params|optional|default|max|type|description|name|sql|reason)`/g;
const MAGIC = new Set([...MANIFEST_SRC.matchAll(/__(?:user_id|now|uuid)\b/g)].map((m) => `:${m[0]}`));
const standard = JSON.parse(readFileSync(join(ROOT, 'docs/standard/standard.json'), 'utf8')) as { clauses: Array<{ id: string; chapter: string; status: string; url: string }> };
const CLAUSES = new Map(standard.clauses.map((c) => [c.id, c]));

/** The anti-patterns #175 requires fixtures for, plus the two it forbids the skill to recommend. */
const REQUIRED_ANTI_PATTERNS = ['Cross-tenant access', 'Guessed identifiers', 'Replayable grants', 'Unsafe writes', 'Migration or action drift', 'Raw browser SQL', 'Client-only authorization', 'Injection surface'];

describe('proappstore-data-migrations-actions: no fabricated APIs', () => {
  it('every app.<module> it names is a real SDK module', () => {
    const named = new Set([...allText.matchAll(/\bapp\.([a-z]+)\b/g)].map((m) => m[1]!));
    expect(named.size).toBeGreaterThan(4);
    for (const m of named) expect(SDK_MODULES.has(m), `app.${m}`).toBe(true);
  });

  it('every app.<module>.<member> it names exists in the SDK source (except the deliberately absent ones in the blocker cases)', () => {
    const absent = new Set(cases.flatMap((c) => (c.expect.absent_methods ?? []).map((m) => `${c.expect.feature}.${m}`)));
    const named = new Set([...allText.matchAll(/\bapp\.([a-z]+)\.([A-Za-z]+)\b/g)].map((m) => `${m[1]}.${m[2]}`).filter((n) => !absent.has(n)));
    expect(named.size).toBeGreaterThan(3);
    for (const n of named) {
      const [mod, member] = n.split('.') as [string, string];
      expect(sdkHas(mod, member), `app.${n} is not on the SDK`).toBe(true);
    }
  });

  it('every manifest key it names is one the platform validator/executor understands', () => {
    const named = new Set([...allText.matchAll(MANIFEST_KEY_RE)].map((m) => m[1]!));
    expect(named.size).toBeGreaterThan(8);
    for (const k of named) expect(new RegExp(`\\b${k}\\b`).test(MANIFEST_SRC), `manifest key ${k}`).toBe(true);
    // Keys the blocker cases declare absent must genuinely be absent.
    for (const k of cases.flatMap((c) => c.expect.absent_keys ?? [])) {
      expect(MANIFEST_SRC).not.toMatch(new RegExp(`\\b${k}\\b`));
      expect(negatives).toContain(`auth.${k}`);
    }
  });

  it('every magic parameter it names is one the executor injects', () => {
    const named = new Set([...allText.matchAll(/:__[a-z_]+/g)].map((m) => m[0]));
    expect([...named].sort()).toEqual([...MAGIC].sort());
  });

  it('every recipe it names is one the recipe tool serves', () => {
    const named = new Set([...allText.matchAll(/[Rr]ecipe[s]?[: ]+`([a-z-]+)`(?:, `([a-z-]+)`)*/g)].flatMap((m) => m[0].match(/`([a-z-]+)`/g)!.map((x) => x.slice(1, -1))));
    expect(named.size).toBeGreaterThan(2);
    for (const r of named) expect(RECIPES.has(r), r).toBe(true);
  });

  it('every sdk_reference feature it names is in the tool enum', () => {
    const src = readFileSync(join(ROOT, 'packages/mcp/src/platform-tools.ts'), 'utf8');
    const features = new Set([...(/feature:\s*z\.enum\(\[([\s\S]*?)\]\)/.exec(src)![1]!).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!));
    const named = [...skillMd.matchAll(/feature `([a-z_]+)`(?:(?:, |, and | \/ )`([a-z_]+)`)*/g)].flatMap((m) => m[0].match(/`([a-z_]+)`/g)!.map((x) => x.slice(1, -1)));
    expect(named.length).toBeGreaterThan(2);
    for (const f of named) expect(features.has(f), `feature ${f}`).toBe(true);
  });

  it('cites only active clauses, each linked at its published URL, and covers every DATA clause', () => {
    const cited = new Set([...allText.matchAll(/PAS-[A-Z]+-\d{3}/g)].map((m) => m[0]));
    for (const id of cited) {
      const c = CLAUSES.get(id);
      expect(c, `${id} is not in the standard`).toBeTruthy();
      expect(c!.status, id).toBe('active');
      expect(allText, `${id} never linked to ${c!.url}`).toContain(`[${id}](${c!.url})`);
    }
    // PAS-DATA-015 (service bindings) is about platform Worker code, not app data — the only DATA clause a data skill need not cite.
    for (const c of standard.clauses.filter((c) => c.chapter === 'DATA' && c.status === 'active' && c.id !== 'PAS-DATA-015')) expect(cited.has(c.id), `${c.id} is never cited`).toBe(true);
  });
});

describe('proappstore-data-migrations-actions: security content', () => {
  it('names every anti-pattern, each with a detect, clause, remediation and proof', () => {
    for (const ap of REQUIRED_ANTI_PATTERNS) {
      const idx = antiPatterns.indexOf(`. ${ap}\n`);
      expect(idx, `anti-pattern "${ap}" missing`).toBeGreaterThan(-1);
      const section = antiPatterns.slice(idx).split(/\n## /)[0]!;
      for (const part of ['**Detect:**', '**Why:**', '**Clause:**', '**Remediate:**', '**Prove:**']) expect(section, `${ap}: ${part}`).toContain(part);
    }
  });

  it('never recommends raw browser SQL or client-only authorization', () => {
    // app.db.* may appear only as a thing to detect, a team-only tool, or a rejected substitute.
    for (const para of allText.split(/\n\s*\n/)) {
      if (para.startsWith('## ')) continue; // example headings name the finding
      if (/app\.db\.(query|execute|batch)/.test(para)) expect(para, `paragraph recommends raw SQL: "${para.slice(0, 80)}…"`).toMatch(/team|admin|local|never|not|Finding|Detect|Do not use|403|forbidden|\| [^|]*raw/i);
    }
    expect(skillMd).toMatch(/SQL is the security boundary/);
    expect(skillMd).toMatch(/client-side check is never authorization/);
    expect(tables).toMatch(/role metadata alone/);
    expect(antiPatterns).toMatch(/## 7\. Client-only authorization/);
    expect(antiPatterns).toMatch(/## 6\. Raw browser SQL/);
  });

  it('server-owned magic parameters replace client identity, time and ids', () => {
    expect(tables).toMatch(/`user_id`, `owner_id`, `created_at`, `role` as client params/);
    for (const m of [':__user_id', ':__now', ':__uuid']) expect(skillMd).toContain(m);
  });

  it('migrations are additive, appended, deploy-applied and verified', () => {
    expect(tables).toMatch(/editing a deployed entry; `DROP`, `RENAME`, `DELETE`, `UPDATE` in a migration/);
    expect(tables).toMatch(/Applied migration\(s\)/);
    expect(tables).toMatch(/`schema_status`/);
    expect(output).toMatch(/### Migration verification/);
    expect(output).toMatch(/### Deployment checks/);
    expect(output).toMatch(/### Negative tests to add/);
  });

  it('unsupported requirements each carry an interim pattern and a clause, and never a substitute', () => {
    const rows = unsupported.split('\n').filter((l) => /^\| [A-Z]/.test(l) && !/^\| Requirement/.test(l));
    expect(rows.length).toBeGreaterThanOrEqual(10);
    for (const r of rows) {
      const cells = r.split('|').map((c) => c.trim());
      expect(cells[3], `${cells[1]}: no interim pattern`).toBeTruthy();
      expect(cells[4], `${cells[1]}: no clause`).toMatch(/PAS-[A-Z]+-\d{3}/);
      expect(cells[3]).not.toMatch(/Firebase|Supabase|Mongo|own Worker|external cron|browser timer/i);
    }
    expect(unsupported).toMatch(/#123/);
    expect(unsupported).toMatch(/#148/);
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
      expect(REQUIRED_ANTI_PATTERNS).toContain(c.anti_pattern);
      for (const part of ['Finding:', 'Remediation:', 'Prove:']) expect(ex).toContain(part);
    } else {
      expect(ex).toMatch(/Tests:/);
      expect(ex).toMatch(/\| Need \| Decision \| Clause \|/);
    }
    expect(ex).toMatch(/Unsupported:/);
    if ((c.expect.unsupported ?? []).length === 0) expect(ex).toMatch(/Unsupported:\s*none/);
    for (const u of c.expect.unsupported ?? []) expect(unsupported, `unsupported table lacks "${u}"`).toContain(u);
  });

  it('uses real SDK surfaces, real manifest keys and real magic parameters in the example', () => {
    const ex = exampleFor(c.id);
    for (const s of c.expect.surfaces ?? []) {
      const [, mod, member] = /^app\.([a-z]+)\.([A-Za-z]+)$/.exec(s)!;
      expect(sdkHas(mod!, member!), s).toBe(true);
      expect(ex, `${s} not in example`).toContain(s);
    }
    for (const k of c.expect.manifest ?? []) {
      expect(ex, `manifest key ${k} not in example`).toContain(k);
      expect(MANIFEST_SRC).toMatch(new RegExp(`\\b${/^[a-z_]+/.exec(k)![0]}\\b`));
    }
    for (const m of c.expect.magic ?? []) {
      expect(MAGIC.has(m), m).toBe(true);
      expect(ex, `${m} not in example`).toContain(m);
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
    if (c.expect.issue) expect(negatives + unsupported).toContain(c.expect.issue);
    for (const m of c.expect.absent_methods ?? []) {
      expect(sdkHas(c.expect.feature!, m), `app.${c.expect.feature}.${m} unexpectedly exists`).toBe(false);
      expect(negatives).toContain(`app.${c.expect.feature}.${m}()`);
    }
    for (const d of c.expect.docs ?? []) {
      expect(existsSync(join(ROOT, 'docs', `${d}.md`)), d).toBe(true);
      expect(negatives).toContain(`https://docs.proappstore.online/${d}/`);
    }
  });
});
