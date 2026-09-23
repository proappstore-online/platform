import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Content evaluations for the proappstore-publish-deploy skill (#174).
 * The skill is advisory: it drives git, pnpm and the MCP status/QA tools, so
 * its correctness is in its references. Every MCP tool, workflow step, deploy
 * log line, CLI command and build stamp it names must exist; every clause it
 * cites must be active and linked; every #174 scenario must be answerable;
 * and it must never handle credentials, never offer a manual infrastructure
 * path, never claim production success from unit tests, roll back only by
 * revert, never edit migrations, and always require the evidence bundle.
 */
const ROOT = resolve(__dirname, '..');
const SKILL = join(ROOT, 'skills', 'proappstore-publish-deploy');
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
  expect: { tools?: string[]; log_lines?: string[]; clauses?: string[]; unsupported?: string[]; rejected?: string[]; cli?: string[]; docs?: string[]; human_pending?: boolean; build_stamp?: boolean; revert?: boolean };
}
const cases = (JSON.parse(read('evals', 'cases.json')) as { cases: Case[] }).cases;

/** Real MCP tool names from every `server.tool(` registration. */
const TOOLS = new Set(
  readdirSync(join(ROOT, 'packages/mcp/src')).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .flatMap((f) => [...readFileSync(join(ROOT, 'packages/mcp/src', f), 'utf8').matchAll(/server\.tool\(\s*["']([a-z_]+)["']/g)].map((m) => m[1]!)),
);
/** The canonical deploy workflow every app ships (scripts/sync-template-workflow.mjs keeps template-app equal to it). */
const DEPLOY_YML = readFileSync(join(ROOT, 'packages/admin/src/__fixtures__/canonical-deploy.yml'), 'utf8');
const STEP_NAMES = [...DEPLOY_YML.matchAll(/^\s+- name: (.+)$/gm)].map((m) => m[1]!);
/** CLI subcommands: `new Command('x')` in packages/cli/src plus the top-level create/publish. */
const CLI = new Set(
  readdirSync(join(ROOT, 'packages/cli/src')).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .flatMap((f) => [...readFileSync(join(ROOT, 'packages/cli/src', f), 'utf8').matchAll(/(?:new Command|\.command)\(\s*['"]([a-z]+)/g)].map((m) => m[1]!)),
);
const SDK_MODULES = new Set(
  [...readFileSync(join(ROOT, 'packages/sdk/src/index.ts'), 'utf8').matchAll(/^\s+readonly ([a-z]+):/gm)].map((m) => m[1]!),
);
const standard = JSON.parse(readFileSync(join(ROOT, 'docs/standard/standard.json'), 'utf8')) as { clauses: Array<{ id: string; chapter: string; status: string; url: string }> };
const CLAUSES = new Map(standard.clauses.map((c) => [c.id, c]));

const REQUIRED_ANTI_PATTERNS = ['Manual infrastructure deploy', 'Infrastructure secrets in the repository', 'Pushing on red, or weakening a gate', 'Rolling back schema by editing history', 'Success claimed from unit tests', 'Stale assets served', 'Blind retry', 'Missing evidence bundle', 'Registered actions drift from the manifest'];
/** Release clauses a publish/deploy skill must cite. */
const REQUIRED_CLAUSES = ['PAS-STACK-004', 'PAS-STACK-005', 'PAS-OPS-001', 'PAS-OPS-004', 'PAS-OPS-005', 'PAS-OPS-006', 'PAS-OPS-008', 'PAS-OPS-009', 'PAS-OPS-010', 'PAS-OPS-012', 'PAS-OPS-015', 'PAS-OPS-019', 'PAS-OPS-020', 'PAS-DATA-002'];
/** Backticked snake_case that is not an MCP tool: manifest keys and example names. */
const NOT_TOOLS = /^(requires_auth|app_roles|dry_run|list_tasks_by_priority)$/;

describe('proappstore-publish-deploy: no fabricated APIs', () => {
  it('every MCP tool it names is registered on the server, and the allow-list is read-only apart from qa_run', () => {
    const named = new Set([...(skillMd + tables + antiPatterns + unsupported).matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]!).filter((n) => !NOT_TOOLS.test(n)));
    expect(named.size).toBeGreaterThan(6);
    for (const n of named) expect(TOOLS.has(n), `\`${n}\` is not a registered MCP tool`).toBe(true);
    const allowed = /allowed-tools: (.*)/.exec(skillMd)![1]!.split(/\s+/);
    for (const t of allowed) expect(TOOLS.has(t), t).toBe(true);
    expect(allowed).not.toContain('provision_pas_app');
    expect(allowed).not.toContain('scaffold_app');
    expect(allowed).not.toContain('qa_save_flow');
    expect(allowed).not.toContain('qa_mint_key');
    expect(allowed).toContain('qa_run');
  });

  it('every workflow step it names is a step of the canonical deploy workflow', () => {
    const named = new Set([...allText.matchAll(/\*([A-Z][A-Za-z0-9 ]+?)\*(?![*])/g)].map((m) => m[1]!).filter((s) => /^(Build|Apply|Mint|Upload|Register|Run E2E|Check|Locate|Install|Publish|Fail|Code)/.test(s)));
    expect(named.size).toBeGreaterThanOrEqual(5);
    for (const s of named) expect(STEP_NAMES.some((n) => n.startsWith(s)), `workflow step "${s}"`).toBe(true);
  });

  it('every deploy log line it relies on is emitted by the canonical deploy workflow', () => {
    for (const line of ['Applied migration(s):', 'already:', 'Registered ', 'app tool(s)', 'Deployed apps/']) {
      expect(skillMd + tables, `skill never names log line ${line}`).toContain(line);
      expect(DEPLOY_YML, `deploy.yml never emits ${line}`).toContain(line.replace('Registered ', 'Registered $('));
    }
    expect(DEPLOY_YML).toContain('VITE_COMMIT_SHA');
    expect(readFileSync(join(ROOT, 'packages/sdk/src/logs.ts'), 'utf8')).toMatch(/build: this\.options\.build/);
  });

  it('every pas CLI command it names exists', () => {
    const named = new Set([...allText.matchAll(/`pas ([a-z]+)/g)].map((m) => m[1]!));
    expect(named.size).toBeGreaterThan(2);
    for (const c of named) expect(CLI.has(c), `pas ${c}`).toBe(true);
  });

  it('every app.<module> it names is a real SDK module', () => {
    const named = new Set([...allText.matchAll(/\bapp\.([a-z]+)\b/g)].map((m) => m[1]!));
    expect(named.size).toBeGreaterThan(1);
    for (const m of named) expect(SDK_MODULES.has(m), `app.${m}`).toBe(true);
  });

  it('cites only active clauses, each linked at its published URL, and every release clause', () => {
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

describe('proappstore-publish-deploy: security content', () => {
  it('names every anti-pattern, each with detect, why, clause, remediate and prove', () => {
    for (const ap of REQUIRED_ANTI_PATTERNS) {
      const idx = antiPatterns.indexOf(`. ${ap}\n`);
      expect(idx, `anti-pattern "${ap}" missing`).toBeGreaterThan(-1);
      const section = antiPatterns.slice(idx).split(/\n## /)[0]!;
      for (const part of ['**Detect:**', '**Why:**', '**Clause:**', '**Remediate:**', '**Prove:**']) expect(section, `${ap}: ${part}`).toContain(part);
    }
  });

  it('never handles credentials and never offers a manual infrastructure path', () => {
    expect(skillMd).toMatch(/never handle credentials/i);
    expect(skillMd).not.toMatch(/PAS_SESSION_TOKEN=|CLOUDFLARE_API_TOKEN=|wrangler (deploy|publish|r2)\b/);
    for (const para of allText.split(/\n\s*\n/)) {
      if (para.startsWith('## ') || para.startsWith('|')) continue;
      if (/\btokens?\b|wrangler|copy(ing)? .*into R2|\.env\b/i.test(para)) expect(para, `paragraph mentions credentials/infra without forbidding it: "${para.trim().slice(0, 90)}…"`).toMatch(/\b(never|no|not|forbidden|blocker|rejected|OIDC)\b/i);
    }
    expect(negatives).toMatch(/Blocker: \*\*credentials\*\*/);
    expect(unsupported).toMatch(/Deploying without a push/);
  });

  it('never claims production success from unit tests, and keeps the human checks pending', () => {
    expect(skillMd).toMatch(/A deploy is failed until the smoke passes/);
    expect(skillMd).toMatch(/unit tests, a green build or\s+an uploaded bundle are not/);
    expect(skillMd).toMatch(/record them\s+as pending, never as passed/);
    expect(antiPatterns).toMatch(/## 5\. Success claimed from unit tests/);
    expect(output).toMatch(/pending \(human\)/);
    expect(negatives).toMatch(/Blocker: \*\*manual-verification\*\*/);
  });

  it('rolls back only by revert, never edits migrations, and handles repository policy', () => {
    expect(skillMd).toMatch(/Rollback is a revert on `main`/);
    expect(skillMd).toMatch(/never edits or deletes an applied entry/);
    expect(tables).toMatch(/`git revert <sha>` → push → deploy → smoke passes/);
    expect(tables).toMatch(/Rollback needs a column gone \| — \| not possible/);
    expect(skillMd).toMatch(/Never bypass protection or force-push/);
    expect(negatives).toMatch(/Blocker: \*\*repository-policy\*\*/);
  });

  it('requires the evidence bundle and defines idempotent retry and partial-deployment recovery', () => {
    const bundle = tables.slice(tables.indexOf('## Evidence bundle'));
    for (const item of ['Commit SHA', 'Deploy run URL', 'Smoke / QA run id', '`schema_status`', '`pas check` output', 'Repository secrets list', 'Served build SHA', 'human checklist']) expect(bundle, item).toContain(item);
    expect(output).toMatch(/### Evidence bundle/);
    expect(output).toMatch(/marked incomplete|Blockers/);
    expect(tables).toMatch(/every step is idempotent/);
    expect(tables).toMatch(/Partial deployment/);
    expect(antiPatterns).toMatch(/## 8\. Missing evidence bundle/);
  });

  it('unsupported requirements each carry an interim pattern and a clause, and never a manual workaround', () => {
    const rows = unsupported.split('\n').filter((l) => /^\| [A-Z]/.test(l) && !/^\| Requirement/.test(l));
    expect(rows.length).toBeGreaterThanOrEqual(8);
    for (const r of rows) {
      const cells = r.split('|').map((c) => c.trim());
      expect(cells[3], `${cells[1]}: no interim pattern`).toBeTruthy();
      expect(cells[4], `${cells[1]}: no clause`).toMatch(/PAS-[A-Z]+-\d{3}/);
      expect(cells[3]).not.toMatch(/wrangler|manual upload|copy .* R2|stored token/i);
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
  });

  it('names real tools, real log lines and real CLI commands in the example', () => {
    const ex = exampleFor(c.id);
    for (const t of c.expect.tools ?? []) {
      expect(TOOLS.has(t), t).toBe(true);
      expect(ex, `${t} not in example`).toContain(`\`${t}\``);
    }
    for (const l of c.expect.log_lines ?? []) {
      expect(ex, `log line ${l} not in example`).toContain(l);
      expect(DEPLOY_YML).toContain(l === 'Registered' ? 'Registered $(' : l);
    }
    for (const cmd of c.expect.cli ?? []) {
      expect(ex, `${cmd} not in example`).toContain(`\`${cmd}`);
      expect(CLI.has(cmd.split(' ')[1]!), cmd).toBe(true);
    }
    if (c.expect.human_pending) expect(ex).toMatch(/human checks pending/);
    if (c.expect.build_stamp) expect(ex).toMatch(/`build`/);
    if (c.expect.revert) expect(ex).toMatch(/`git revert <sha>`/);
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

  it('lists the rejected practices as "do not"', () => {
    for (const r of c.expect.rejected ?? []) expect(tables + unsupported + antiPatterns, `"${r}" never rejected`).toContain(r);
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
    for (const d of c.expect.docs ?? []) {
      expect(existsSync(join(ROOT, 'docs', `${d}.md`)), d).toBe(true);
      expect(negatives).toContain(`https://docs.proappstore.online/${d}/`);
    }
  });
});
