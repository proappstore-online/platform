import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { validate } from './lib/validate-json-schema.js';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The Application Standard (docs/standard, #160) promises stable clause IDs
 * and URLs. Findings cite `standard/<page>/#pas-<chapter>-<nnn>`, so an ID
 * that is duplicated, unanchored, or mis-anchored silently breaks every issue
 * that cites it. These tests hold the promise the governance page makes.
 */

const DOCS = resolve(__dirname, '../docs');
const STANDARD = join(DOCS, 'standard');
const CHAPTERS = ['STACK', 'AUTH', 'DATA', 'INT', 'UI', 'OPS'] as const;
const ID_RE = /^PAS-(STACK|AUTH|DATA|INT|UI|OPS)-(\d{3})$/;
const REQUIRED_SECTIONS = [
  '**Rule.**', '**Applicability.**', '**Rationale.**', '**Recommended implementation.**',
  '**Conforming example.**', '**Non-conforming example.**', '**Evidence.**',
  '**Remediation.**', '**Tests.**', '**Supporting links.**',
];

function mdFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? mdFiles(join(dir, e.name)) : e.name.endsWith('.md') ? [join(dir, e.name)] : [],
  );
}

/** Drop fenced code blocks so a template or example inside one is not a clause. */
function withoutFences(md: string): string {
  return md.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, '');
}

interface Clause { id: string; anchor: string | null; file: string; line: number; body: string; withdrawn: boolean }

function clausesIn(file: string): Clause[] {
  const text = withoutFences(readFileSync(file, 'utf8'));
  const lines = text.split('\n');
  const out: Clause[] = [];
  lines.forEach((l, i) => {
    const m = /^###\s+(PAS-[A-Z]+-\d+)\b(.*)$/.exec(l);
    if (!m) return;
    const anchor = /\{#([^}\s]+)\}\s*$/.exec(m[2]!)?.[1] ?? null;
    let end = lines.findIndex((x, j) => j > i && /^#{1,3}\s/.test(x));
    if (end < 0) end = lines.length;
    const body = lines.slice(i + 1, end).join('\n');
    out.push({ id: m[1]!, anchor, file, line: i + 1, body, withdrawn: /\*\*Withdrawn in \d+\.\d+\.\*\*/.test(body) });
  });
  return out;
}

const standardFiles = mdFiles(STANDARD);
const clauses = standardFiles.flatMap(clausesIn);
const chapterPages = new Map<string, string>(CHAPTERS.map((c) => {
  const slug = { STACK: 'stack', AUTH: 'auth', DATA: 'data', INT: 'integrations', UI: 'ui', OPS: 'ops' }[c];
  return [c, join(STANDARD, `${slug}.md`)];
}));

describe('standard: clause IDs', () => {
  it('follow the PAS-<CHAPTER>-<NNN> grammar', () => {
    for (const c of clauses) expect(c.id, `${c.file}:${c.line}`).toMatch(ID_RE);
  });

  it('are unique across the whole standard', () => {
    const seen = new Map<string, string>();
    for (const c of clauses) {
      expect(seen.has(c.id), `${c.id} at ${c.file}:${c.line} already defined at ${seen.get(c.id)}`).toBe(false);
      seen.set(c.id, `${c.file}:${c.line}`);
    }
  });

  it('carry an explicit anchor equal to the lower-cased ID', () => {
    for (const c of clauses) expect(c.anchor, `${c.file}:${c.line} ${c.id}`).toBe(c.id.toLowerCase());
  });

  it("live on their chapter's page, in increasing order (append-only)", () => {
    for (const c of clauses) {
      const chapter = ID_RE.exec(c.id)![1]!;
      expect(c.file, `${c.id} must live on the ${chapter} chapter page`).toBe(chapterPages.get(chapter));
    }
    for (const [chapter, file] of chapterPages) {
      const nums = clauses.filter((c) => c.file === file).map((c) => Number(ID_RE.exec(c.id)![2]));
      for (let i = 1; i < nums.length; i++) {
        expect(nums[i]!, `${chapter} clauses out of order at #${nums[i]}`).toBeGreaterThan(nums[i - 1]!);
      }
    }
  });

  it('withdrawn clauses keep their ID; live clauses have every template section', () => {
    for (const c of clauses) {
      if (c.withdrawn) continue;
      for (const s of REQUIRED_SECTIONS) expect(c.body, `${c.id} lacks ${s}`).toContain(s);
      expect(c.body, `${c.id} lacks a Severity/Verification/Enforcement line`).toMatch(/\*\*Severity:\*\*.*\*\*Verification:\*\*.*\*\*Enforcement:\*\*.*\*\*Since:\*\*/);
    }
  });
});

describe('standard: governance page', () => {
  const governance = readFileSync(join(STANDARD, 'governance.md'), 'utf8');

  it('lists exactly the chapter codes the tests enforce', () => {
    const table = governance.slice(governance.indexOf('## Chapter taxonomy'), governance.indexOf('## Clause ID grammar'));
    const codes = [...table.matchAll(/^\| `([A-Z]+)` \|/gm)].map((m) => m[1]);
    expect(codes).toEqual([...CHAPTERS]);
  });

  it('publishes a clause template with every required section', () => {
    const start = governance.indexOf('## Clause template');
    const fence = governance.indexOf('````markdown', start);
    const template = governance.slice(fence, governance.indexOf('````', fence + 4));
    expect(template).toMatch(/^### PAS-<CHAPTER>-<NNN> — .* \{#pas-<chapter>-<nnn>\}$/m);
    for (const s of REQUIRED_SECTIONS) expect(template, `template lacks ${s}`).toContain(s);
    expect(template).toMatch(/\*\*Severity:\*\*.*\*\*Verification:\*\*.*\*\*Enforcement:\*\*.*\*\*Since:\*\*/);
  });

  it('every chapter page states the same standard version as the governance page', () => {
    const version = /\*\*Standard version (\d+\.\d+)\*\*/.exec(governance)![1];
    for (const file of standardFiles) {
      if (file.endsWith('changelog.md')) continue;
      expect(readFileSync(file, 'utf8'), file).toContain(`**Standard version ${version}**`);
    }
    expect(readFileSync(join(STANDARD, 'changelog.md'), 'utf8')).toContain(`## ${version}`);
  });
});

describe('standard: public links', () => {
  const clauseIds = new Set(clauses.map((c) => c.id.toLowerCase()));

  function relativeLinks(file: string): { target: string; anchor: string | null }[] {
    return [...withoutFences(readFileSync(file, 'utf8')).matchAll(/\]\(([^)\s]+)\)/g)]
      .map((m) => m[1]!)
      .filter((t) => !/^(https?:|mailto:|#)/.test(t))
      .map((t) => { const [p, a] = t.split('#'); return { target: p!, anchor: a ?? null }; });
  }

  it('every relative link inside the standard resolves to a file', () => {
    for (const file of standardFiles) {
      for (const { target } of relativeLinks(file)) {
        expect(existsSync(resolve(dirname(file), target)), `${file} → ${target}`).toBe(true);
      }
    }
  });

  it('every link into the standard from the rest of the docs resolves, including clause anchors', () => {
    const all = mdFiles(DOCS).filter((f) => !f.includes('/.vitepress/'));
    let inbound = 0;
    for (const file of all) {
      for (const { target, anchor } of relativeLinks(file)) {
        const abs = resolve(dirname(file), target);
        if (!abs.startsWith(STANDARD)) continue;
        inbound++;
        expect(existsSync(abs), `${file} → ${target}`).toBe(true);
        if (anchor && /^pas-[a-z]+-\d{3}$/.test(anchor)) {
          expect(clauseIds.has(anchor), `${file} cites unknown clause #${anchor}`).toBe(true);
        }
      }
    }
    expect(inbound, 'the standard must be linked from the rest of the docs').toBeGreaterThan(0);
  });
});

/**
 * #167 — the machine-readable standard and the audit contract. The markdown
 * is canonical; standard.json and llms-full.txt are generated and committed so
 * the unchanged docs publish workflow ships them. These tests hold the three
 * promises: generated == committed, the schemas validate, and every URL in the
 * data resolves to a real page and clause anchor.
 */
describe('standard: machine-readable artifacts (#167)', () => {
  const ROOT = resolve(__dirname, '..');
  const readJson = (rel: string) => JSON.parse(readFileSync(join(STANDARD, rel), 'utf8'));
  const standardSchema = readJson('standard.schema.json');
  const findingSchema = readJson('finding.schema.json');
  const data = readJson('standard.json');
  const example = readJson('examples/audit.example.json');
  const clauseIds = new Set(clauses.map((c) => c.id.toLowerCase()));

  it('generator output equals the committed standard.json and llms-full.txt (--check)', () => {
    expect(() => execFileSync('node', ['scripts/build-standard-data.mjs', '--check'], { cwd: ROOT, stdio: 'pipe' })).not.toThrow();
  });

  it('standard.json validates against standard.schema.json', () => {
    expect(validate(standardSchema, data)).toEqual([]);
  });

  it('standard.json carries every clause the markdown defines, at the same version', () => {
    const version = /\*\*Standard version (\d+\.\d+)\*\*/.exec(readFileSync(join(STANDARD, 'governance.md'), 'utf8'))![1];
    expect(data.standard.version).toBe(version);
    expect(data.clauses.map((c: { id: string }) => c.id).sort()).toEqual(clauses.map((c) => c.id).sort());
    for (const c of data.clauses) if (c.status === 'active') expect(c.since <= version, `${c.id} since ${c.since} > ${version}`).toBe(true);
  });

  it('every clause url in standard.json resolves to an existing page and clause anchor', () => {
    for (const c of data.clauses) {
      const m = /^https:\/\/docs\.proappstore\.online\/standard\/([a-z-]+)\/#(pas-[a-z]+-\d{3})$/.exec(c.url);
      expect(m, `${c.id}: malformed url ${c.url}`).not.toBeNull();
      expect(existsSync(join(STANDARD, `${m![1]}.md`)), `${c.id}: page ${m![1]}.md missing`).toBe(true);
      expect(m![2]).toBe(c.id.toLowerCase());
      expect(clauseIds.has(m![2]), `${c.id}: anchor not found in markdown`).toBe(true);
      expect(c.page).toBe(m![1]);
    }
    for (const ch of data.chapters) expect(existsSync(join(STANDARD, `${ch.page}.md`)), `chapter page ${ch.page}.md`).toBe(true);
  });

  it('the example audit validates against finding.schema.json', () => {
    expect(validate(findingSchema, example)).toEqual([]);
  });

  it('example findings cite real clauses, with the exact url from standard.json', () => {
    const byId = new Map<string, { url: string; severity: string; verification: string }>(data.clauses.map((c: any) => [c.id, c]));
    for (const f of example.findings) {
      const clause = byId.get(f.clause_id);
      expect(clause, `${f.clause_id} is not a published clause`).toBeDefined();
      expect(f.clause_url).toBe(clause!.url);
      expect(f.verification).toBe(clause!.verification);
    }
  });

  it('example findings have unique dedupe keys that follow <app_id>:<clause_id>:<primary evidence path>', () => {
    const keys = example.findings.map((f: any) => f.dedupe_key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const f of example.findings) {
      expect(f.evidence.length, `${f.clause_id}: evidence required`).toBeGreaterThan(0);
      expect(f.dedupe_key).toBe(`${example.app_id}:${f.clause_id}:${f.evidence[0].path}`);
    }
  });

  it('example fails carry impact, remediation and acceptance tests; human clauses stay manual-review; titles name the defect', () => {
    for (const f of example.findings) {
      if (f.state === 'fail') {
        expect(f.impact?.length ?? 0).toBeGreaterThan(0);
        expect(f.remediation?.length ?? 0).toBeGreaterThan(0);
        expect(f.acceptance_tests?.length ?? 0).toBeGreaterThan(0);
      }
      if (f.verification === 'human') { expect(f.state).toBe('manual-review'); expect(f.human_validation).toBe('required'); }
      expect(f.title, `${f.clause_id}: title must name the defect, not the clause`).not.toMatch(/^PAS-[A-Z]+-\d{3}/);
      if (f.state === 'not-applicable') expect(f.applicability.applies).toBe(false);
    }
    expect(example.findings.map((f: any) => f.state).sort()).toEqual(['fail', 'fail', 'manual-review', 'not-applicable']);
  });

  it('compliance-checks.json validates against its schema and cites only published clause URLs', () => {
    const map = readJson('compliance-checks.json');
    expect(validate(readJson('compliance-checks.schema.json'), map)).toEqual([]);
    expect(map.standard_version).toBe(data.standard.version);
    const urlById = new Map<string, string>(data.clauses.map((c: any) => [c.id, c.url]));
    for (const check of map.checks) for (const c of check.clauses) expect(c.url, `${check.id} → ${c.clauseId}`).toBe(urlById.get(c.clauseId));
    expect(() => execFileSync('node', ['--experimental-strip-types', 'scripts/build-compliance-map.mjs', '--check'], { cwd: ROOT, stdio: 'pipe' })).not.toThrow();
  });

  it('the validator itself rejects a broken finding', () => {
    const broken = JSON.parse(JSON.stringify(example));
    broken.findings[0].state = 'maybe';
    broken.findings[0].clause_url = 'https://example.com/x';
    delete broken.findings[0].dedupe_key;
    const errors = validate(findingSchema, broken);
    expect(errors.some((e) => e.includes('not in enum'))).toBe(true);
    expect(errors.some((e) => e.includes('does not match'))).toBe(true);
    expect(errors.some((e) => e.includes('missing required dedupe_key'))).toBe(true);
  });

  it('the AI-friendly indexes link the artifacts and every linked artifact exists', () => {
    for (const rel of ['llms.txt', 'standard/llms.txt']) {
      const txt = readFileSync(join(DOCS, rel), 'utf8');
      for (const art of ['standard.json', 'standard.schema.json', 'finding.schema.json', 'llms-full.txt', 'examples/audit.example.json', 'audit-instructions/', 'compliance-checks.json', 'compliance-checks.schema.json']) {
        expect(txt, `${rel} must link ${art}`).toContain(`https://docs.proappstore.online/standard/${art}`);
      }
      for (const m of txt.matchAll(/https:\/\/docs\.proappstore\.online\/standard\/([A-Za-z0-9./_-]+)/g)) {
        const p = m[1]!;
        const file = p.endsWith('/') ? `${p.slice(0, -1) || 'index'}.md` : p.includes('.') ? p : `${p}.md`;
        expect(existsSync(join(STANDARD, file.replace(/^index\.md$/, 'index.md'))), `${rel} → ${p}`).toBe(true);
      }
    }
  });
});

/**
 * #178 — the approved-template catalogue published beside the standard. The
 * TS module in build-core is canonical; docs/templates/catalogue.json is its
 * generated copy and must validate, cite real clauses, and never drift.
 */
describe('templates: approved-template catalogue (#178)', () => {
  const ROOT = resolve(__dirname, '..');
  const TEMPLATES = join(DOCS, 'templates');
  const catalogue = JSON.parse(readFileSync(join(TEMPLATES, 'catalogue.json'), 'utf8'));
  const schema = JSON.parse(readFileSync(join(TEMPLATES, 'catalogue.schema.json'), 'utf8'));

  it('validates against its schema and the generator --check passes', () => {
    expect(validate(schema, catalogue)).toEqual([]);
    expect(() => execFileSync('node', ['--experimental-strip-types', 'scripts/build-template-catalogue.mjs', '--check'], { cwd: ROOT, stdio: 'pipe' })).not.toThrow();
  });

  it('cites only published, active clauses as known deviations, and names a default that exists', () => {
    const std = JSON.parse(readFileSync(join(STANDARD, 'standard.json'), 'utf8'));
    const active = new Set(std.clauses.filter((c: any) => c.status === 'active').map((c: any) => c.id));
    for (const t of catalogue.templates) for (const d of t.security_compliance.known_deviations) expect(active.has(d), `${t.id} → ${d}`).toBe(true);
    expect(catalogue.templates.some((t: any) => t.id === catalogue.default && t.default && t.status === 'approved')).toBe(true);
  });

  it('is discoverable: the page, the nav, and llms.txt link it, and its links resolve', () => {
    expect(existsSync(join(TEMPLATES, 'index.md'))).toBe(true);
    expect(readFileSync(join(DOCS, 'llms.txt'), 'utf8')).toContain('https://docs.proappstore.online/templates/catalogue.json');
    expect(readFileSync(resolve(ROOT, '.github/workflows/publish-docs.yml'), 'utf8')).toContain('templates/index.md');
    for (const m of withoutFences(readFileSync(join(TEMPLATES, 'index.md'), 'utf8')).matchAll(/\]\(([^)\s]+)\)/g)) {
      const t = m[1]!;
      if (/^(https?:|#)/.test(t)) continue;
      expect(existsSync(resolve(TEMPLATES, t.split('#')[0]!)), `templates/index.md → ${t}`).toBe(true);
    }
  });
});
