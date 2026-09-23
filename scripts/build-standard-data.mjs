#!/usr/bin/env node
/**
 * Build the machine-readable Application Standard (#167).
 *
 * Parses docs/standard/*.md — the same clause grammar test/docs-standard.test.ts
 * enforces — and emits, deterministically (no timestamps, stable key order):
 *
 *   docs/standard/standard.json    the clauses as data (validated by standard.schema.json)
 *   docs/standard/llms-full.txt    every clause as plain text, for AI ingestion
 *
 * The markdown stays the source of truth; these files are committed so the
 * unchanged docs publish workflow ships them. `--check` fails when the committed
 * files differ from what the markdown produces (run in `pnpm test`).
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STANDARD = join(ROOT, 'docs', 'standard');
const BASE_URL = 'https://docs.proappstore.online/standard/';
const CHAPTER_SLUGS = { STACK: 'stack', AUTH: 'auth', DATA: 'data', INT: 'integrations', UI: 'ui', OPS: 'ops' };
const SECTION_KEYS = {
  Rule: 'rule', Applicability: 'applicability', Rationale: 'rationale',
  'Recommended implementation': 'recommended_implementation', 'Conforming example': 'conforming_example',
  'Non-conforming example': 'non_conforming_example', Evidence: 'evidence', Remediation: 'remediation',
  Tests: 'tests', 'Supporting links': 'supporting_links',
};

const read = (name) => readFileSync(join(STANDARD, name), 'utf8');

function withoutFences(md) {
  return md.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, (m) => m.replace(/[^\n]/g, ' '));
}

function parseGovernance(md) {
  const version = /\*\*Standard version (\d+\.\d+)\*\*/.exec(md)?.[1];
  if (!version) throw new Error('governance.md: no standard version');
  const table = md.slice(md.indexOf('## Chapter taxonomy'), md.indexOf('## Clause ID grammar'));
  const chapters = [...table.matchAll(/^\| `([A-Z]+)` \| \[([^\]]+)\]\(\.\/([a-z-]+)\.md\) \| ([^|]+) \|$/gm)]
    .map((m) => ({ code: m[1], title: m[2], page: m[3], scope: m[4].trim() }));
  if (chapters.length === 0) throw new Error('governance.md: no chapter taxonomy rows');
  return { version, chapters };
}

function normalizeVerification(raw) {
  const s = raw.toLowerCase();
  if (s.startsWith('automated')) return 'automated';
  if (s.startsWith('human')) return 'human';
  return 'manual';
}
function normalizeEnforcement(raw) {
  const s = raw.toLowerCase();
  if (s.startsWith('automated')) return 'automated';
  if (s.startsWith('optional')) return 'optional';
  return 'none';
}

function parseClauses(page, code, md) {
  const masked = withoutFences(md); // same length as md: fence contents blanked, so line indices align
  const lines = md.split('\n');
  const maskedLines = masked.split('\n');
  const clauses = [];
  maskedLines.forEach((l, i) => {
    const m = /^###\s+(PAS-[A-Z]+-\d{3})\s+—\s+(.*?)\s*\{#([^}\s]+)\}\s*$/.exec(l);
    if (!m) return;
    let end = maskedLines.findIndex((x, j) => j > i && /^#{1,3}\s/.test(x));
    if (end < 0) end = lines.length;
    const body = lines.slice(i + 1, end).join('\n').trim();
    const maskedBody = maskedLines.slice(i + 1, end).join('\n');
    const id = m[1];
    const [, chapter, number] = /^PAS-([A-Z]+)-(\d{3})$/.exec(id);
    if (chapter !== code) throw new Error(`${id} found on ${page}.md`);
    const base = { id, chapter, number: Number(number), title: m[2], page, anchor: m[3], url: `${BASE_URL}${page}/#${m[3]}` };
    const withdrawn = /\*\*Withdrawn in (\d+\.\d+)\.\*\*\s*([\s\S]*)/.exec(body);
    if (withdrawn) {
      clauses.push({ ...base, status: 'withdrawn', withdrawn_in: withdrawn[1], withdrawn_reason: withdrawn[2].trim() });
      return;
    }
    const meta = /\*\*Severity:\*\*\s*(.+?)\s*·\s*\*\*Verification:\*\*\s*(.+?)\s*·\s*\*\*Enforcement:\*\*\s*(.+?)\s*·\s*\*\*Since:\*\*\s*(\d+\.\d+)(?:\s*·\s*\*\*Kind:\*\*\s*(.+?))?\s*$/m.exec(maskedBody.replace(/\n/g, '\n'));
    if (!meta) throw new Error(`${id}: metadata line not parseable`);
    // Sections: a bold label at line start, text until the next label or the end.
    const labelRe = /^\*\*([A-Z][A-Za-z -]*)\.\*\*/gm;
    const marks = [];
    let mm;
    while ((mm = labelRe.exec(maskedBody))) if (SECTION_KEYS[mm[1]]) marks.push({ key: SECTION_KEYS[mm[1]], start: mm.index, textStart: mm.index + mm[0].length });
    const sections = {};
    marks.forEach((mk, k) => {
      const stop = k + 1 < marks.length ? marks[k + 1].start : body.length;
      sections[mk.key] = body.slice(mk.textStart, stop).trim();
    });
    for (const key of Object.values(SECTION_KEYS)) if (!(key in sections)) throw new Error(`${id}: missing section ${key}`);
    const clause = {
      ...base,
      status: 'active',
      severity: meta[1].toLowerCase(),
      verification: normalizeVerification(meta[2]),
      verification_detail: meta[2],
      enforcement: normalizeEnforcement(meta[3]),
      enforcement_detail: meta[3],
      since: meta[4],
    };
    if (meta[5]) clause.kind = meta[5].trim();
    Object.assign(clause, sections);
    clauses.push(clause);
  });
  return clauses;
}

export function build() {
  const { version, chapters } = parseGovernance(read('governance.md'));
  const out = {
    $schema: `${BASE_URL}standard.schema.json`,
    standard: {
      name: 'ProAppStore Recommended Application Standard',
      version,
      base_url: BASE_URL,
      html: `${BASE_URL}`,
      audit_instructions: `${BASE_URL}audit-instructions/`,
      finding_schema: `${BASE_URL}finding.schema.json`,
      full_text: `${BASE_URL}llms-full.txt`,
      changelog: `${BASE_URL}changelog/`,
      id_grammar: 'PAS-<CHAPTER>-<NNN>',
      severities: ['critical', 'high', 'medium', 'low', 'info'],
      verification_classes: ['automated', 'manual', 'human'],
      result_states: ['pass', 'fail', 'not-applicable', 'manual-review'],
      evidence_classes: ['configuration', 'source', 'process', 'runtime', 'documentation'],
      dedupe_key: '<app_id>:<clause_id>:<primary evidence path>',
    },
    chapters: chapters.map((c) => ({ ...c, url: `${BASE_URL}${c.page}/` })),
    clauses: [],
  };
  for (const c of chapters) {
    const file = join(STANDARD, `${c.page}.md`);
    if (!existsSync(file)) throw new Error(`chapter page missing: ${file}`);
    out.clauses.push(...parseClauses(c.page, c.code, readFileSync(file, 'utf8')));
  }
  const json = JSON.stringify(out, null, 2) + '\n';

  const txt = [];
  txt.push(`# ${out.standard.name} — full text`, '',
    `Version ${version}. Canonical HTML: ${BASE_URL} · Data: ${BASE_URL}standard.json · Audit instructions: ${out.standard.audit_instructions}`,
    `Clause URLs are stable: ${BASE_URL}<chapter page>/#<clause id in lower case>. Findings must cite them.`, '');
  for (const ch of out.chapters) {
    txt.push(`## Chapter ${ch.code} — ${ch.title}`, ch.scope, `URL: ${ch.url}`, '');
    const cs = out.clauses.filter((k) => k.chapter === ch.code);
    if (cs.length === 0) txt.push('(no clauses published in this chapter)', '');
    for (const k of cs) {
      txt.push(`### ${k.id} — ${k.title}`, `URL: ${k.url}`);
      if (k.status === 'withdrawn') { txt.push(`Withdrawn in ${k.withdrawn_in}. ${k.withdrawn_reason}`, ''); continue; }
      txt.push(`Severity: ${k.severity} · Verification: ${k.verification} (${k.verification_detail}) · Enforcement: ${k.enforcement_detail} · Since: ${k.since}${k.kind ? ` · Kind: ${k.kind}` : ''}`, '');
      for (const [label, key] of Object.entries(SECTION_KEYS)) txt.push(`${label}: ${k[key]}`, '');
    }
  }
  return { json, txt: txt.join('\n') + '\n' };
}

const OUTPUTS = { 'standard.json': 'json', 'llms-full.txt': 'txt' };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const built = build();
  let drift = 0;
  for (const [name, key] of Object.entries(OUTPUTS)) {
    const path = join(STANDARD, name);
    const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
    if (check) {
      if (current !== built[key]) { console.error(`✗ docs/standard/${name} is out of date — run: node scripts/build-standard-data.mjs`); drift++; }
      else console.log(`✓ docs/standard/${name} is up to date`);
    } else {
      writeFileSync(path, built[key]);
      console.log(`wrote docs/standard/${name}`);
    }
  }
  if (check && drift) process.exit(1);
}
