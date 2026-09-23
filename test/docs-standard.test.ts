import { readdirSync, readFileSync, existsSync } from 'node:fs';
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
