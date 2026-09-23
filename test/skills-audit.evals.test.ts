import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validate, type Json } from './lib/validate-json-schema.js';

/**
 * Content evaluations for the audit-proappstore-app skill (#172).
 * The skill audits repositories against the published standard, so the
 * evaluation runs its direct rules over deterministic repository fixtures
 * and checks the findings it must produce against the published finding
 * contract, the standard's data file and the deduplication formula. Nothing
 * here calls a model; the rules are regexes the skill itself publishes.
 */
const ROOT = resolve(__dirname, '..');
const SKILL = join(ROOT, 'skills', 'audit-proappstore-app');
const read = (...p: string[]) => readFileSync(join(SKILL, ...p), 'utf8');

const skillMd = read('SKILL.md');
const tables = read('references', 'decision-tables.md');
const directRules = read('references', 'direct-rules.md');
const unsupported = read('references', 'unsupported-requirements.md');
const examples = read('references', 'worked-examples.md');
const negatives = read('references', 'negative-cases.md');
const output = read('references', 'output-template.md');
const allText = [skillMd, tables, directRules, unsupported, examples, negatives, output].join('\n');

const standard = JSON.parse(readFileSync(join(ROOT, 'docs/standard/standard.json'), 'utf8')) as { standard: { version: string }; clauses: Array<{ id: string; status: string; url: string; severity: string; verification: string }> };
const CLAUSES = new Map(standard.clauses.map((c) => [c.id, c]));
const FINDING_SCHEMA = JSON.parse(readFileSync(join(ROOT, 'docs/standard/finding.schema.json'), 'utf8'));

interface Finding { clause_id: string; clause_url: string; title: string; state: string; severity: string; verification: string; evidence: Array<{ path: string; class: string }>; dedupe_key: string; confidence: string; human_validation: string; remediation?: string; acceptance_tests?: string[] }
interface Fixture { id: string; kind: 'conforming' | 'non-conforming'; app_id: string; repository: string; hosted: boolean; category: string; files: Record<string, string>; expected: { fail: string[]; findings: Finding[]; pass?: string[] } }
interface Case { id: string; class: string; blocker?: string; fixture?: string; title: string; expect: { fail?: string[]; clauses?: string[]; rules?: number[]; state?: string; mode?: string; absent_clauses?: string[] } }
const cases = (JSON.parse(read('evals', 'cases.json')) as { cases: Case[] }).cases;
const fixtures = new Map(readdirSync(join(SKILL, 'evals', 'fixtures')).filter((f) => f.endsWith('.json')).map((f) => { const fx = JSON.parse(read('evals', 'fixtures', f)) as Fixture; return [fx.id, fx]; }));

/** The skill's direct rules, as the skill publishes them (regex column of direct-rules.md), applied to a fixture. */
function ruleRegex(n: number): RegExp {
  const row = directRules.split('\n').find((l) => l.startsWith(`| ${n} |`));
  expect(row, `direct rule ${n} missing from direct-rules.md`).toBeTruthy();
  const cell = row!.split(/(?<!\\)\|/)[2]!.trim();
  const src = /`([^`]+)`/.exec(cell)![1]!.replace(/\\\|/g, '|');
  return new RegExp(src);
}
function applyDirectRules(fx: Fixture): Set<string> {
  const fails = new Set<string>();
  const src = Object.entries(fx.files).filter(([p]) => p.startsWith('web/src/'));
  const html = fx.files['web/index.html'] ?? '';
  // 1 — initPro without platform-cookie on a hosted app (context rule)
  if (fx.hosted) for (const [, c] of src) if (/initPro\(/.test(c) && !/authMode:\s*'platform-cookie'/.test(c)) fails.add('PAS-AUTH-001');
  const hits = (n: number) => src.some(([, c]) => ruleRegex(n).test(c));
  if (hits(2)) { fails.add('PAS-AUTH-002'); fails.add('PAS-AUTH-003'); }
  if (hits(3)) fails.add('PAS-AUTH-003');
  if (hits(4)) fails.add('PAS-DATA-003');
  if (hits(5)) fails.add('PAS-UI-014');
  if (ruleRegex(6).test(html)) fails.add('PAS-UI-007');
  if (hits(7)) fails.add('PAS-DATA-016');
  // 8 — an authenticated statement with no :__user_id (context rule over mcp.json)
  if (fx.files['mcp.json']) {
    const manifest = JSON.parse(fx.files['mcp.json']) as { tools: Array<{ requires_auth?: boolean; sql?: string; statements?: string[] }> };
    for (const t of manifest.tools) if (t.requires_auth) for (const s of t.statements ?? [t.sql!]) if (!/:__user_id/.test(s) || /:__user_id\s*=\s*:__user_id/.test(s)) fails.add('PAS-DATA-007');
  }
  return fails;
}
/** Rule 2 also names PAS-AUTH-003; the fixtures' expected sets list the clause the finding is written against. */
const expectedFor = (fx: Fixture) => new Set(fx.expected.fail);
const normalise = (s: Set<string>, fx: Fixture) => new Set([...s].filter((id) => expectedFor(fx).has(id) || !['PAS-AUTH-003'].includes(id)));

describe('audit-proappstore-app: no fabricated surfaces', () => {
  it('every MCP tool it names is registered and the allow-list is read-only', () => {
    const TOOLS = new Set(readdirSync(join(ROOT, 'packages/mcp/src')).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .flatMap((f) => [...readFileSync(join(ROOT, 'packages/mcp/src', f), 'utf8').matchAll(/server\.tool\(\s*["']([a-z_]+)["']/g)].map((m) => m[1]!)));
    const named = new Set([...(skillMd + tables).matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]!).filter((n) => !/^(requires_auth|app_id|human_validation|standard_version|commit_sha|audited_at|update_item|org_members)$/.test(n)));
    for (const n of named) expect(TOOLS.has(n), `\`${n}\``).toBe(true);
    const allowed = /allowed-tools: (.*)/.exec(skillMd)![1]!.split(/\s+/);
    for (const t of allowed) expect(TOOLS.has(t), t).toBe(true);
    for (const t of ['provision_pas_app', 'scaffold_app', 'qa_run', 'write_file', 'add_ticket']) expect(allowed).not.toContain(t);
  });

  it('cites only active clauses, each linked at its published URL, and the audit contract pages exist', () => {
    const cited = new Set([...allText.matchAll(/PAS-[A-Z]+-\d{3}/g)].map((m) => m[0]));
    const absent = new Set(cases.flatMap((c) => c.expect.absent_clauses ?? []));
    for (const id of cited) {
      if (absent.has(id)) { expect(CLAUSES.has(id), `${id} unexpectedly exists`).toBe(false); continue; }
      const c = CLAUSES.get(id);
      expect(c, `${id} is not in the standard`).toBeTruthy();
      expect(c!.status, id).toBe('active');
      expect(allText, `${id} never linked to ${c!.url}`).toContain(`[${id}](${c!.url})`);
    }
    for (const f of ['docs/standard/audit-instructions.md', 'docs/standard/audit-model.md', 'docs/standard/finding.schema.json', 'docs/standard/standard.json']) expect(existsSync(join(ROOT, f)), f).toBe(true);
    expect(skillMd.match(/standard-version: "([^"]+)"/)![1]).toBe(standard.standard.version);
  });

  it('publishes the same direct rules as the audit instructions, each with a clause', () => {
    const published = readFileSync(join(ROOT, 'docs/standard/audit-instructions.md'), 'utf8');
    const rows = directRules.split('\n').filter((l) => /^\| \d+ \|/.test(l));
    expect(rows).toHaveLength(8);
    for (const row of rows) {
      const grep = /`(grep [^`]+)`/.exec(row);
      if (grep) expect(published, `audit-instructions lacks "${grep[1]}"`).toContain(grep[1]!);
      else { expect(row).toContain('requires_auth: true'); expect(published).toContain('tautological'); }
      expect(row).toMatch(/PAS-[A-Z]+-\d{3}/);
    }
  });
});

describe('audit-proappstore-app: rules the standard imposes on an auditor', () => {
  it('fetches the standard, records one result per clause, keeps human clauses manual-review, defaults to read-only, checks duplicates', () => {
    expect(skillMd).toMatch(/The standard is fetched, at its current version/);
    expect(skillMd).toMatch(/Never audit from memory/);
    expect(skillMd).toMatch(/Every clause gets a result/);
    expect(skillMd).toMatch(/Absent evidence for a MUST is a `fail`/);
    expect(skillMd).toMatch(/Human clauses stay `manual-review`/);
    for (const id of ['PAS-AUTH-020', 'PAS-UI-006', 'PAS-UI-023', 'PAS-OPS-019']) { expect(CLAUSES.get(id)?.verification, id).toBe('human'); expect(skillMd).toContain(id); }
    expect(skillMd).toMatch(/Read-only by default/);
    expect(skillMd).toMatch(/after searching the repository's\s+issues for the deduplication key/);
    expect(skillMd).toMatch(/Never invent architecture the standard forbids/);
    expect(skillMd).toMatch(/never a secret, a token, or personal data/);
    expect(negatives).toMatch(/Blocker:\s*\*\*duplicate\*\*/);
    expect(negatives).toMatch(/Blocker:\s*\*\*credentials\*\*/);
  });

  it('the output template is the finding contract: envelope fields and finding fields all present', () => {
    for (const k of FINDING_SCHEMA.required as string[]) if (k !== '$schema') expect(output, `envelope field ${k}`).toContain(k);
    for (const k of FINDING_SCHEMA.$defs.finding.required as string[]) expect(output, `finding field ${k}`).toContain(k);
    expect(output).toContain('https://docs.proappstore.online/standard/finding.schema.json');
  });
});

describe.each([...fixtures.values()])('fixture $id ($kind)', (fx) => {
  it('the direct rules produce exactly the expected fail set, and produce it again on rerun', () => {
    const first = normalise(applyDirectRules(fx), fx);
    const second = normalise(applyDirectRules(fx), fx);
    expect([...first].sort()).toEqual([...fx.expected.fail].sort());
    expect([...second].sort()).toEqual([...first].sort());
    if (fx.kind === 'conforming') { expect(first.size).toBe(0); expect(fx.expected.findings).toHaveLength(0); expect((fx.expected.pass ?? []).length).toBeGreaterThan(3); }
    else expect(fx.expected.findings.length).toBeGreaterThan(0);
  });

  it('every expected finding validates against the finding contract and agrees with standard.json', () => {
    for (const f of fx.expected.findings) {
      expect(validate({ $ref: '#/$defs/finding' }, f as unknown as Json, FINDING_SCHEMA), f.clause_id).toEqual([]);
      const c = CLAUSES.get(f.clause_id)!;
      expect(c, f.clause_id).toBeTruthy();
      expect(f.clause_url).toBe(c.url);
      expect(f.severity, `${f.clause_id} severity is the clause default`).toBe(c.severity);
      expect(f.verification).toBe(c.verification);
      expect(f.state).toBe('fail');
      expect(fx.expected.fail).toContain(f.clause_id);
      expect(f.dedupe_key).toBe(`${fx.app_id}:${f.clause_id}:${f.evidence[0]!.path}`);
      expect(fx.files[f.evidence[0]!.path], `evidence path ${f.evidence[0]!.path} exists in the fixture`).toBeDefined();
      expect(f.title).not.toMatch(/^PAS-/); // the title is the defect, not the clause id
      expect(f.remediation).toBeTruthy();
      expect((f.acceptance_tests ?? []).length).toBeGreaterThan(0);
      expect(f.confidence).toBe('high');
      const text = JSON.stringify(f);
      expect(text).not.toMatch(/\b[0-9a-f]{32,}\b|ghp_|sk-[A-Za-z0-9]{8}/);
    }
  });

  it('the assembled report validates against the full contract', () => {
    const report = { $schema: 'https://docs.proappstore.online/standard/finding.schema.json', standard_version: standard.standard.version, app_id: fx.app_id, repository: fx.repository, commit_sha: 'a'.repeat(7), audited_at: '2026-09-23', auditor: { kind: 'ai', name: 'audit-proappstore-app' }, findings: fx.expected.findings };
    expect(validate(FINDING_SCHEMA, report as unknown as Json)).toEqual([]);
  });
});

describe.each(cases.filter((c) => c.class === 'scenario'))('scenario $id', (c) => {
  it('has a worked example, and its fixture (if any) and clauses agree with the references', () => {
    const i = examples.indexOf(`## ${c.id}`);
    expect(i, `no worked example ## ${c.id}`).toBeGreaterThan(-1);
    const ex = examples.slice(i).split(/\n## /)[0]!;
    expect(ex).toMatch(/Unsupported:/);
    if (c.fixture) {
      expect(fixtures.has(c.fixture), c.fixture).toBe(true);
      expect(ex).toContain(`evals/fixtures/${c.fixture}.json`);
      expect([...fixtures.get(c.fixture)!.expected.fail].sort()).toEqual([...(c.expect.fail ?? [])].sort());
      for (const f of fixtures.get(c.fixture)!.expected.findings) expect(ex, `example lacks dedupe key ${f.dedupe_key}`).toContain(f.dedupe_key);
    }
    for (const id of c.expect.clauses ?? []) { expect(CLAUSES.get(id)?.status, id).toBe('active'); expect(ex, `${id} not in example`).toContain(id); }
    for (const n of c.expect.rules ?? []) expect(ex, `rule ${n} not named in example`).toMatch(new RegExp(`rules? (?:\\d+ and )?${n}\\b`));
    if (c.expect.state) expect(ex).toContain(`\`${c.expect.state}\``);
    if (c.expect.mode === 'issue-creation') { expect(ex).toMatch(/dedupe key/); expect(ex).toMatch(/Read-only mode would have produced only the report/); }
  });
});

describe.each(cases.filter((c) => c.class === 'blocker'))('blocker $id', (c) => {
  it('is described in negative-cases.md with its class and its clauses are active', () => {
    expect(negatives).toMatch(new RegExp(`Blocker[^*]{0,40}\\*\\*${c.blocker}`));
    for (const id of c.expect.clauses ?? []) { expect(CLAUSES.get(id)?.status, id).toBe('active'); expect(negatives + unsupported).toContain(id); }
    for (const id of c.expect.absent_clauses ?? []) { expect(CLAUSES.has(id)).toBe(false); expect(negatives).toContain(id); }
  });
});
