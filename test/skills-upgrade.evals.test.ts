import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Content evaluations for the proappstore-upgrade-app skill (#177).
 * The skill is advisory and read-only on the platform side, so its
 * correctness is in its references: the baseline it quotes must equal the
 * template catalogue, the workflow steps and log lines must exist in the
 * canonical deploy workflow, the compliance check ids in the published map,
 * the auth modes and UI exports in the SDK, every clause active and linked;
 * every #177 scenario must be answerable; and it must default to a dry run,
 * change one stage per commit, never overwrite product-owned files, require
 * review before destructive or broad changes, and never handle credentials.
 */
const ROOT = resolve(__dirname, '..');
const SKILL = join(ROOT, 'skills', 'proappstore-upgrade-app');
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
  expect: { tools?: string[]; clauses?: string[]; unsupported?: string[]; preserved?: string[]; no_edit?: boolean; cli?: string[]; baseline?: string[]; steps?: string[]; log_lines?: string[]; auth_modes?: string[]; absent_auth_modes?: string[]; surfaces?: string[]; human_pending?: boolean; checks?: string[]; ui_exports?: string[]; revert?: boolean; docs?: string[] };
}
const cases = (JSON.parse(read('evals', 'cases.json')) as { cases: Case[] }).cases;

const TOOLS = new Set(
  readdirSync(join(ROOT, 'packages/mcp/src')).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .flatMap((f) => [...readFileSync(join(ROOT, 'packages/mcp/src', f), 'utf8').matchAll(/server\.tool\(\s*["']([a-z_]+)["']/g)].map((m) => m[1]!)),
);
const CATALOGUE_SRC = readFileSync(join(ROOT, 'packages/build-core/src/template-catalogue.ts'), 'utf8');
const reqM = /requires:\s*\{\s*sdk:\s*'([^']*)',\s*cli:\s*'([^']*)',\s*node:\s*'([^']*)',\s*pnpm:\s*'([^']*)'/.exec(CATALOGUE_SRC)!;
const REQUIRES = { sdk: reqM[1]!, cli: reqM[2]!, node: reqM[3]!, pnpm: reqM[4]! };
const KNOWN_DEVIATIONS = [...(/known_deviations:\s*\[([^\]]*)\]/.exec(CATALOGUE_SRC)![1]!).matchAll(/'(PAS-[A-Z]+-\d{3})'/g)].map((m) => m[1]!);
const DEPLOY_YML = readFileSync(join(ROOT, 'packages/admin/src/__fixtures__/canonical-deploy.yml'), 'utf8');
const STEP_NAMES = [...DEPLOY_YML.matchAll(/^\s+- name: (.+)$/gm)].map((m) => m[1]!);
const CHECK_IDS = new Set((JSON.parse(readFileSync(join(ROOT, 'docs/standard/compliance-checks.json'), 'utf8')) as { checks: Array<{ id: string }> }).checks.map((c) => c.id));
const CLI = new Set(
  readdirSync(join(ROOT, 'packages/cli/src')).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .flatMap((f) => [...readFileSync(join(ROOT, 'packages/cli/src', f), 'utf8').matchAll(/(?:new Command|\.command)\(\s*['"]([a-z]+)/g)].map((m) => m[1]!)),
);
const SDK_SRC = join(ROOT, 'packages/sdk/src');
const AUTH_MODES = new Set([...(/export type AuthMode = ([^;]+);/.exec(readFileSync(join(SDK_SRC, 'auth.ts'), 'utf8'))![1]!).matchAll(/'([a-z-]+)'/g)].map((m) => m[1]!));
const SDK_MODULES = new Set([...readFileSync(join(SDK_SRC, 'index.ts'), 'utf8').matchAll(/^\s+readonly ([a-z]+):/gm)].map((m) => m[1]!));
function sdkHas(mod: string, member: string): boolean {
  const file = join(SDK_SRC, `${mod}.ts`);
  if (!existsSync(file)) return false;
  return new RegExp(`^\\s+(?:async\\s+)?(?:get\\s+)?${member}\\s*[(:<]`, 'm').test(readFileSync(file, 'utf8'));
}
const UI_EXPORTS = new Set(
  readdirSync(SDK_SRC).filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith('.test.ts'))
    .flatMap((f) => [...readFileSync(join(SDK_SRC, f), 'utf8').matchAll(/export (?:function|const) ([A-Za-z]+)/g)].map((m) => m[1]!)),
);
const standard = JSON.parse(readFileSync(join(ROOT, 'docs/standard/standard.json'), 'utf8')) as { standard: { version: string }; clauses: Array<{ id: string; status: string; url: string }> };
const CLAUSES = new Map(standard.clauses.map((c) => [c.id, c]));

const REQUIRED_ANTI_PATTERNS = ['Overwriting product code with the template', 'Legacy bearer sessions on a hosted app', 'Drifted or credentialed deploy workflow', 'Missing or weakened gates', 'Old UI/PWA baseline', 'Unpinned toolchain, stale SDK', 'Legacy data access', 'Big-bang upgrade', 'Template placeholders and boilerplate'];
const REQUIRED_CLAUSES = ['PAS-STACK-001', 'PAS-STACK-002', 'PAS-STACK-003', 'PAS-STACK-005', 'PAS-AUTH-001', 'PAS-AUTH-002', 'PAS-AUTH-011', 'PAS-AUTH-020', 'PAS-DATA-002', 'PAS-DATA-003', 'PAS-DATA-004', 'PAS-OPS-004', 'PAS-OPS-006', 'PAS-OPS-007', 'PAS-OPS-009', 'PAS-UI-002', 'PAS-UI-007', 'PAS-UI-018', 'PAS-UI-020', 'PAS-UI-023'];
const NOT_TOOLS = /^(requires_auth|template_id|template_rev|user_scalable)$/;

describe('proappstore-upgrade-app: no fabricated APIs', () => {
  it('every MCP tool it names is registered, and the allow-list is read-only', () => {
    const named = new Set([...(skillMd + tables + antiPatterns + unsupported).matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]!).filter((n) => !NOT_TOOLS.test(n)));
    expect(named.size).toBeGreaterThan(5);
    for (const n of named) expect(TOOLS.has(n), `\`${n}\` is not a registered MCP tool`).toBe(true);
    const allowed = /allowed-tools: (.*)/.exec(skillMd)![1]!.split(/\s+/);
    for (const t of allowed) expect(TOOLS.has(t), t).toBe(true);
    for (const t of ['provision_pas_app', 'scaffold_app', 'qa_run', 'qa_save_flow', 'write_file']) expect(allowed).not.toContain(t);
  });

  it('quotes the baseline exactly as the template catalogue publishes it, including the known deviations', () => {
    for (const [k, v] of Object.entries(REQUIRES)) {
      const short = v.split(' ')[0]!;
      expect(tables, `baseline ${k} ${short}`).toContain(`${k} ${short}`);
    }
    for (const id of KNOWN_DEVIATIONS) expect(allText, `known deviation ${id} never cited`).toContain(id);
    expect(skillMd).toContain('known deviations');
    expect(skillMd.match(/standard-version: "([^"]+)"/)![1]).toBe(standard.standard.version);
    expect(tables).toContain(`(\`${standard.standard.version}\`)`);
  });

  it('every workflow step and deploy log line it names exists in the canonical deploy workflow', () => {
    const steps = new Set([...allText.matchAll(/\*([A-Z][A-Za-z0-9 ]+?)\*(?![*])/g)].map((m) => m[1]!).filter((s) => /^(Build|Apply|Mint|Upload|Register|Run E2E)/.test(s)));
    expect(steps.size).toBeGreaterThanOrEqual(5);
    for (const s of steps) expect(STEP_NAMES.some((n) => n.startsWith(s)), `workflow step "${s}"`).toBe(true);
    for (const line of ['Applied migration(s)', 'Registered $(', 'Deployed apps/', 'already', 'VITE_COMMIT_SHA']) expect(DEPLOY_YML).toContain(line);
    for (const line of ['Applied migration(s)', 'Registered N app tool(s)', 'Deployed apps/', 'VITE_COMMIT_SHA']) expect(allText).toContain(line);
  });

  it('every compliance check id it names is in the published map', () => {
    const named = new Set([...allText.matchAll(/`([a-z]+(?:-[a-z]+)+)`/g)].map((m) => m[1]!).filter((n) => !/^(platform-cookie|legacy-bearer|stores-theme|create-proappstore-app|proappstore-[a-z-]+|choose-proappstore-architecture|frozen-lockfile|data-theme|template-app|maximum-scale|user-scalable|prod)$/.test(n)));
    expect(named.size).toBeGreaterThan(6);
    for (const id of named) expect(CHECK_IDS.has(id), `compliance check \`${id}\``).toBe(true);
  });

  it('names only the auth modes the SDK has, real SDK members, real UI exports and real CLI commands', () => {
    const absent = new Set(cases.flatMap((c) => c.expect.absent_auth_modes ?? []));
    const modes = new Set([...allText.matchAll(/authMode: '([a-z-]+)'|`(platform-cookie|legacy-bearer|hybrid)`/g)].map((m) => m[1] ?? m[2]!));
    for (const m of modes) if (!absent.has(m)) expect(AUTH_MODES.has(m), `authMode ${m}`).toBe(true);
    for (const m of absent) expect(AUTH_MODES.has(m), `${m} unexpectedly exists`).toBe(false);
    for (const n of new Set([...allText.matchAll(/\bapp\.([a-z]+)\.([A-Za-z]+)\b/g)].map((m) => `${m[1]}.${m[2]}`))) {
      const [mod, member] = n.split('.') as [string, string];
      expect(SDK_MODULES.has(mod), `app.${mod}`).toBe(true);
      expect(sdkHas(mod, member), `app.${n} is not on the SDK`).toBe(true);
    }
    for (const n of new Set([...allText.matchAll(/`(useTheme|ThemeToggle|useProAuth|ProShell|initPro)`/g)].map((m) => m[1]!))) expect(UI_EXPORTS.has(n), n).toBe(true);
    for (const c of new Set([...allText.matchAll(/`pas ([a-z]+)/g)].map((m) => m[1]!))) expect(CLI.has(c), `pas ${c}`).toBe(true);
  });

  it('cites only active clauses, each linked at its published URL, and every upgrade clause', () => {
    const cited = new Set([...allText.matchAll(/PAS-[A-Z]+-\d{3}/g)].map((m) => m[0]));
    for (const id of cited) {
      const c = CLAUSES.get(id);
      expect(c, `${id} is not in the standard`).toBeTruthy();
      expect(c!.status, id).toBe('active');
      expect(allText, `${id} never linked to ${c!.url}`).toContain(`[${id}](${c!.url})`);
    }
    for (const id of REQUIRED_CLAUSES) expect(cited.has(id), `${id} is never cited`).toBe(true);
  });
});

describe('proappstore-upgrade-app: safety content', () => {
  it('names every anti-pattern, each with detect, why, clause, remediate and prove', () => {
    for (const ap of REQUIRED_ANTI_PATTERNS) {
      const idx = antiPatterns.indexOf(`. ${ap}\n`);
      expect(idx, `anti-pattern "${ap}" missing`).toBeGreaterThan(-1);
      const section = antiPatterns.slice(idx).split(/\n## /)[0]!;
      for (const part of ['**Detect:**', '**Why:**', '**Clause:**', '**Remediate:**', '**Prove:**']) expect(section, `${ap}: ${part}`).toContain(part);
    }
  });

  it('defaults to a dry run, implements one stage per commit, and never overwrites product-owned files', () => {
    expect(skillMd).toMatch(/Dry-run first/);
    expect(skillMd).toMatch(/Nothing is edited until the user\s+picks a stage/);
    expect(skillMd).toMatch(/One stage per run and per commit/);
    expect(skillMd).toMatch(/Product code is never overwritten/);
    expect(tables).toMatch(/## File ownership/);
    for (const f of ['`web/src/**`', '`mcp.json`, `migrations.json`', '`README.md`, `CLAUDE.md`, `web/public/**`']) expect(tables, f).toContain(f);
    expect(tables).toMatch(/replace with the template's `App\.tsx`/);
    expect(tables).toMatch(/## Dry-run report versus bounded implementation/);
    expect(output).toMatch(/dry run, nothing changed/);
    expect(output).toMatch(/Customisations preserved/);
  });

  it('requires explicit review before destructive or broad changes', () => {
    expect(skillMd).toMatch(/Explicit review before anything destructive or broad/);
    expect(skillMd).toMatch(/\*\*Review required\*\*/);
    expect(negatives).toMatch(/Blocker: \*\*review-required\*\*/);
    expect(output).toMatch(/\| Review \| Human \|/);
    expect(antiPatterns).toMatch(/## 1\. Overwriting product code with the template/);
    expect(antiPatterns).toMatch(/## 8\. Big-bang upgrade/);
  });

  it('never handles credentials and keeps the human checks pending', () => {
    expect(skillMd).toMatch(/never handle credentials/i);
    for (const para of allText.split(/\n\s*\n/)) {
      if (para.startsWith('## ') || para.startsWith('|')) continue;
      if (/\btokens?\b|wrangler|\.env\b/i.test(para)) expect(para, `paragraph mentions credentials/infra without forbidding it: "${para.trim().slice(0, 90)}…"`).toMatch(/\b(never|no|not|forbidden|blocker|delete[sd]?|remov(e|ed|al)|keyless)\b/i);
    }
    expect(negatives).toMatch(/Blocker:\s*\*\*credentials\*\*/);
    expect(skillMd).toMatch(/Record those as pending, never as passed/);
    expect(negatives).toMatch(/Blocker: \*\*manual-verification\*\*/);
    expect(skillMd).not.toMatch(/confirm: true/);
  });

  it('unsupported requirements each carry an interim pattern and a clause, and never a rewrite', () => {
    const rows = unsupported.split('\n').filter((l) => /^\| [A-Z]/.test(l) && !/^\| Requirement/.test(l));
    expect(rows.length).toBeGreaterThanOrEqual(8);
    for (const r of rows) {
      const cells = r.split('|').map((c) => c.trim());
      expect(cells[3], `${cells[1]}: no interim pattern`).toBeTruthy();
      expect(cells[4], `${cells[1]}: no clause`).toMatch(/PAS-[A-Z]+-\d{3}/);
      expect(cells[3]).not.toMatch(/re-scaffold|regenerate|rewrite|stored token|legacy-bearer/i);
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
      expect(REQUIRED_ANTI_PATTERNS).toContain(c.anti_pattern);
      for (const part of ['Finding:', 'Remediation:', 'Prove:']) expect(ex).toContain(part);
    }
    expect(ex).toMatch(/Unsupported:/);
    if ((c.expect.unsupported ?? []).length === 0) expect(ex).toMatch(/Unsupported:\s*none/);
    for (const u of c.expect.unsupported ?? []) expect(unsupported, `unsupported table lacks "${u}"`).toContain(u);
    if (c.expect.no_edit) expect(ex).toMatch(/Nothing edited/);
  });

  it('names real tools, baseline values, steps, log lines, checks, surfaces and commands in the example', () => {
    const ex = exampleFor(c.id);
    for (const t of c.expect.tools ?? []) { expect(TOOLS.has(t), t).toBe(true); expect(ex, `${t} not in example`).toContain(`\`${t}\``); }
    for (const k of c.expect.baseline ?? []) expect(ex + tables, `baseline ${k}`).toContain(REQUIRES[k as keyof typeof REQUIRES].split(' ')[0]!);
    for (const s of c.expect.steps ?? []) { expect(STEP_NAMES.some((n) => n.startsWith(s)), s).toBe(true); expect(ex).toContain(`*${s}*`); }
    for (const l of c.expect.log_lines ?? []) { expect(ex, `log line ${l}`).toContain(l); expect(DEPLOY_YML).toContain(l === 'Registered' ? 'Registered $(' : l); }
    for (const id of c.expect.checks ?? []) { expect(CHECK_IDS.has(id), id).toBe(true); expect(ex).toContain(`\`${id}\``); }
    for (const m of c.expect.auth_modes ?? []) { expect(AUTH_MODES.has(m), m).toBe(true); expect(ex).toContain(`'${m}'`); }
    for (const s of c.expect.surfaces ?? []) { const [, mod, member] = /^app\.([a-z]+)\.([A-Za-z]+)$/.exec(s)!; expect(sdkHas(mod!, member!), s).toBe(true); expect(ex).toContain(s); }
    for (const u of c.expect.ui_exports ?? []) { expect(UI_EXPORTS.has(u), u).toBe(true); expect(ex).toContain(`\`${u}\``); }
    for (const cmd of c.expect.cli ?? []) { expect(CLI.has(cmd.split(' ')[1]!), cmd).toBe(true); expect(ex).toContain(`\`${cmd}`); }
    for (const p of c.expect.preserved ?? []) expect(ex, `${p} not listed as preserved`).toContain(p);
    if (c.expect.human_pending) expect(ex).toMatch(/\(pending\)/);
    if (c.expect.revert) expect(ex).toMatch(/`git revert <stage 6 sha>`/);
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
});

describe.each(cases.filter((c) => c.class === 'blocker'))('blocker $id', (c) => {
  it('is described in negative-cases.md with its class and its expectations hold', () => {
    expect(negatives).toMatch(new RegExp(`Blocker[^*]{0,40}\\*\\*${c.blocker}`));
    for (const u of c.expect.unsupported ?? []) expect(unsupported).toContain(u);
    for (const id of c.expect.clauses ?? []) {
      expect(CLAUSES.get(id)?.status, id).toBe('active');
      expect(negatives + unsupported, `${id} not cited for the blocker`).toContain(id);
    }
    for (const m of c.expect.absent_auth_modes ?? []) { expect(AUTH_MODES.has(m)).toBe(false); expect(negatives).toContain(`'${m}'`); }
    for (const d of c.expect.docs ?? []) { expect(existsSync(join(ROOT, 'docs', `${d}.md`)), d).toBe(true); expect(negatives).toContain(`https://docs.proappstore.online/${d}/`); }
  });
});
