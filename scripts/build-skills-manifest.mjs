#!/usr/bin/env node
/**
 * Release gate for the Agent Skills bundles (#176).
 *
 * Reads every skills/<skill>/ directory, validates the bundle (no executables
 * outside scripts/, no oversized binaries, no secret-shaped strings, every
 * file referenced from SKILL.md exists, evals fixtures present), and writes:
 *   - skills/index.json            — name, version, description, allowed-tools,
 *                                    files with SHA-256, bundle size and digest
 *   - docs/skills/evaluations.md   — the published evaluation summary
 *
 *   node scripts/build-skills-manifest.mjs           # regenerate
 *   node scripts/build-skills-manifest.mjs --check   # fail on drift or violation
 *
 * The "last verified" reference is the bundle digest (content-derived, so the
 * committed manifest never lags the commit that produced it); the CI run that
 * passed with that digest is the evidence.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SMOKE_REQUIRED = ['client', 'version', 'date', 'runner', 'tool_calls', 'outcome', 'session_id', 'audit_log_url'];
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const marketPath = join(ROOT, 'marketplace.json');
const SKILLS = join(ROOT, 'skills');
const INDEX = join(SKILLS, 'index.json');
const SUMMARY = join(ROOT, 'docs', 'skills', 'evaluations.md');
const CHECK = process.argv.includes('--check');

const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|woff2?|ttf|otf|wasm|mp[34]|mov)$/i;
const BINARY_CAP = 256 * 1024;
const TEXT_CAP = 128 * 1024;
const SECRET_RE = /(sk-[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|\bBearer\s+[A-Za-z0-9._-]{16,}|\b[0-9a-f]{32,}\b|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|xox[abp]-[A-Za-z0-9-]{10,})/;
const REQUIRED = ['SKILL.md', 'evals/cases.json', 'evals/triggers.json', 'evals/contract.json', 'references/output-template.md'];

const problems = [];
const fail = (m) => problems.push(m);

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  return out;
}
function frontmatter(raw) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(raw);
  if (!m) return null;
  const fm = {}; const metadata = {}; let inMeta = false;
  for (const line of m[1].split('\n')) {
    if (/^metadata:\s*$/.test(line)) { inMeta = true; continue; }
    const nested = /^  ([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (inMeta && nested) { metadata[nested[1]] = nested[2].replace(/^"|"$/g, ''); continue; }
    inMeta = false;
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) fm[kv[1]] = kv[2];
  }
  return { fm, metadata };
}

const standard = JSON.parse(readFileSync(join(ROOT, 'docs/standard/standard.json'), 'utf8')).standard;
const entries = [];
for (const dir of readdirSync(SKILLS).filter((d) => statSync(join(SKILLS, d)).isDirectory()).sort()) {
  const base = join(SKILLS, dir);
  const files = walk(base);
  const rel = (p) => relative(base, p).split('\\').join('/');
  for (const r of REQUIRED) if (!existsSync(join(base, r))) fail(`${dir}: missing ${r}`);
  const raw = readFileSync(join(base, 'SKILL.md'), 'utf8');
  const parsed = frontmatter(raw);
  if (!parsed) { fail(`${dir}: SKILL.md has no frontmatter`); continue; }
  const { fm, metadata } = parsed;
  if (fm.name !== dir) fail(`${dir}: frontmatter name "${fm.name}" ≠ directory`);
  if (!metadata.version) fail(`${dir}: metadata.version missing`);
  const fileEntries = [];
  let bytes = 0;
  const digest = createHash('sha256');
  for (const f of files) {
    const r = rel(f);
    const st = statSync(f);
    const buf = readFileSync(f);
    const isBinary = BINARY_EXT.test(r) || buf.includes(0);
    if (st.mode & 0o111 && !r.startsWith('scripts/')) fail(`${dir}: ${r} is executable outside scripts/`);
    if (isBinary && !r.startsWith('assets/')) fail(`${dir}: binary ${r} outside assets/`);
    if (isBinary && st.size > BINARY_CAP) fail(`${dir}: ${r} is ${st.size} B, over the ${BINARY_CAP} B binary cap`);
    if (!isBinary && st.size > TEXT_CAP) fail(`${dir}: ${r} is ${st.size} B, over the ${TEXT_CAP} B text cap`);
    if (!isBinary) {
      const hit = SECRET_RE.exec(buf.toString('utf8'));
      if (hit && !/^[0-9a-f]{40}$/.test(hit[0])) fail(`${dir}: ${r} contains a secret-shaped string ${hit[0].slice(0, 10)}…`);
    }
    const sha256 = createHash('sha256').update(buf).digest('hex');
    digest.update(`${r}\0${sha256}\n`);
    bytes += st.size;
    fileEntries.push({ path: r, bytes: st.size, sha256 });
  }
  // Every relative reference from SKILL.md and references/ must exist inside the bundle.
  for (const f of files.filter((f) => f.endsWith('.md'))) {
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const t = m[1];
      if (/^(https?:|mailto:|#)/.test(t)) continue;
      const target = resolve(dirname(f), t.split('#')[0]);
      if (!target.startsWith(base)) fail(`${dir}: ${rel(f)} links outside the bundle: ${t}`);
      else if (!existsSync(target)) fail(`${dir}: ${rel(f)} links to a missing file: ${t}`);
    }
  }
  const cases = JSON.parse(readFileSync(join(base, 'evals/cases.json'), 'utf8')).cases;
  const triggers = JSON.parse(readFileSync(join(base, 'evals/triggers.json'), 'utf8'));
  const contract = JSON.parse(readFileSync(join(base, 'evals/contract.json'), 'utf8'));
  const byClass = {};
  for (const c of cases) byClass[c.class] = (byClass[c.class] ?? 0) + 1;
  entries.push({
    name: fm.name, version: metadata.version, description: fm.description, license: fm.license,
    'standard-version': metadata['standard-version'], issue: metadata.issue,
    'allowed-tools': (fm['allowed-tools'] ?? '').split(/\s+/).filter(Boolean),
    mutating: contract.mutating,
    bytes, digest: digest.digest('hex'), files: fileEntries,
    evaluations: {
      cases: cases.length, by_class: byClass,
      trigger_prompts: { positive: triggers.positive.length, negative: triggers.negative.length, sibling: triggers.sibling.length },
      budgets: contract.budgets,
      actual: { skill_md_bytes: statSync(join(base, 'SKILL.md')).size, references_bytes: walk(join(base, 'references')).reduce((n, f) => n + statSync(f).size, 0), bundle_bytes: bytes },
      properties: contract.properties,
    },
  });
}

// Package manifests (#169): the Claude Code plugin and the client-neutral
// marketplace manifest must list exactly the skill bundles, and nothing else.
{
  const names = entries.map((e) => e.name).sort();
  const pluginPath = join(ROOT, '.claude-plugin', 'plugin.json');
  const claudeMarketPath = join(ROOT, '.claude-plugin', 'marketplace.json');
  for (const p of [pluginPath, marketPath, claudeMarketPath]) if (!existsSync(p)) fail(`missing package manifest ${relative(ROOT, p)}`);
  if (existsSync(pluginPath)) {
    const plugin = JSON.parse(readFileSync(pluginPath, 'utf8'));
    const listed = (plugin.skills ?? []).map((s) => s.replace(/^\.\/skills\//, '')).sort();
    if (JSON.stringify(listed) !== JSON.stringify(names)) fail(`.claude-plugin/plugin.json skills ${JSON.stringify(listed)} ≠ bundles ${JSON.stringify(names)}`);
    if (plugin.mcpServers?.proappstore?.url !== 'https://mcp.proappstore.online/mcp') fail('.claude-plugin/plugin.json must bundle the ProAppStore MCP endpoint');
    for (const k of ['name', 'version', 'description', 'license']) if (!plugin[k]) fail(`.claude-plugin/plugin.json lacks ${k}`);
  }
  if (existsSync(marketPath)) {
    const market = JSON.parse(readFileSync(marketPath, 'utf8'));
    const listed = (market.skills ?? []).map((s) => s.name).sort();
    if (JSON.stringify(listed) !== JSON.stringify(names)) fail(`marketplace.json skills ${JSON.stringify(listed)} ≠ bundles ${JSON.stringify(names)}`);
    for (const s of market.skills ?? []) {
      const e = entries.find((x) => x.name === s.name);
      if (e && s.path !== `skills/${e.name}`) fail(`marketplace.json: ${s.name} path ${s.path}`);
      if (e && s.mutating !== e.mutating) fail(`marketplace.json: ${s.name} mutating ${s.mutating} ≠ contract ${e.mutating}`);
    }
    if (!Array.isArray(market.clients) || market.clients.length < 3) fail('marketplace.json must list the supported clients');
    for (const c of market.clients ?? []) for (const k of ['client', 'install', 'update', 'uninstall', 'smoke_evidence']) if (!c[k]) fail(`marketplace.json client ${c.client ?? '?'} lacks ${k}`);
    // #169: smoke evidence is a structured record, never free text. Awaiting rows
    // are honest; a recorded row must carry every required field, non-empty.
    for (const c of market.clients ?? []) {
      const ev = c.smoke_evidence;
      if (!ev || typeof ev !== 'object' || Array.isArray(ev)) { fail(`marketplace.json client ${c.client}: smoke_evidence must be an object`); continue; }
      if (ev.status !== 'awaiting-run' && ev.status !== 'passed') fail(`marketplace.json client ${c.client}: smoke_evidence.status must be "awaiting-run" or "passed"`);
      if (ev.client !== c.client) fail(`marketplace.json client ${c.client}: smoke_evidence.client must match the row`);
      if (ev.status === 'passed') {
        for (const k of SMOKE_REQUIRED) {
          const v = ev[k];
          const ok = k === 'tool_calls' ? Array.isArray(v) && v.length > 0 && v.every((t) => typeof t === 'string' && t) : typeof v === 'string' && v.trim() !== '';
          if (!ok) fail(`marketplace.json client ${c.client}: passed smoke_evidence lacks ${k}`);
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ev.date))) fail(`marketplace.json client ${c.client}: smoke_evidence.date must be YYYY-MM-DD`);
      }
    }
    if (market.mcp?.remote !== 'https://mcp.proappstore.online/mcp') fail('marketplace.json must point at the ProAppStore MCP endpoint');
  }
  if (existsSync(claudeMarketPath)) {
    const m = JSON.parse(readFileSync(claudeMarketPath, 'utf8'));
    if (!m.plugins?.some((p) => p.name === 'proappstore' && p.source === './')) fail('.claude-plugin/marketplace.json must publish the proappstore plugin from this repository');
  }
}

const index = {
  $schema: 'https://docs.proappstore.online/skills/index.schema.json',
  format: 'agentskills.io/specification',
  standard_version: standard.version,
  mcp_endpoint: 'https://mcp.proappstore.online/mcp',
  plugin: '.claude-plugin/plugin.json',
  marketplace: 'marketplace.json',
  skills: entries,
};
const indexJson = `${JSON.stringify(index, null, 2)}\n`;

const PROPS = ['triggering', 'non-triggering', 'tool-selection-order', 'dry-run-confirmation', 'output-schema', 'idempotency', 'failure-recovery', 'citation-accuracy', 'secret-safety', 'context-size'];
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const lines = [];
lines.push('# Agent Skills — evaluation summary');
lines.push('');
lines.push('> Generated by `scripts/build-skills-manifest.mjs` from the skill bundles under');
lines.push('> `skills/` and their `evals/` fixtures (#176). Do not edit by hand; run the');
lines.push('> script and commit. `node scripts/build-skills-manifest.mjs --check` is the');
lines.push('> release gate: it fails CI on any drift or bundle violation.');
lines.push('');
lines.push(`Standard version: **${standard.version}** · MCP endpoint: \`https://mcp.proappstore.online/mcp\` · Manifest: [\`skills/index.json\`](https://github.com/proappstore-online/platform/blob/main/skills/index.json)`);
lines.push('');
lines.push('## What is evaluated');
lines.push('');
lines.push('Every skill is checked, deterministically and on every push, for the ten properties #176 names. The tests are content-driven: expected outcomes live in each skill\'s `evals/` fixtures, never in exact prose.');
lines.push('');
lines.push('| Property | How it is checked | Where |');
lines.push('|---|---|---|');
lines.push('| triggering | positive prompts route to exactly this skill; specific trigger phrases are unique across skills | `test/skills-harness.test.ts` |');
lines.push('| non-triggering | negative prompts route to no skill; sibling prompts route to the named sibling; pairwise ambiguity over every positive prompt | `test/skills-harness.test.ts` |');
lines.push('| tool selection / order | workflow steps name only allow-listed tools; an info tool precedes any mutation; advisory skills never provision | `test/skills-harness.test.ts` |');
lines.push('| dry-run / confirmation | mutating skill: dry-run precedes confirm, refuses without confirm, degrades in read-only mode (real MCP tool with mocks); advisory skills: no confirm, read-only | `packages/mcp/src/skill-create-app.evals.test.ts`, `test/skills.test.ts` |');
lines.push('| output schema | the output template carries the contract\'s sections; every scenario example carries the contract\'s markers | `test/skills-harness.test.ts` |');
lines.push('| idempotency | each skill declares its rerun rule (contract regex); the mutating skill\'s rerun fixtures re-run the real tool | `test/skills-harness.test.ts`, `packages/mcp/src/skill-create-app.evals.test.ts` |');
lines.push('| failure recovery | each skill declares its stop-or-rollback rule; blocker fixtures cover every blocker class in negative-cases | `test/skills-harness.test.ts`, `test/skills.test.ts` |');
lines.push('| citation accuracy | every cited clause exists, is active and is linked at its published URL; no fabricated SDK, MCP, CLI, manifest or workflow surfaces | the per-skill `test/skills-*.evals.test.ts` |');
lines.push('| secret safety | no secret-shaped strings, no credential handling, no infrastructure commands outside prohibitions; the release gate rescans every bundle file | `test/skills.test.ts`, `scripts/build-skills-manifest.mjs` |');
lines.push('| context size | `SKILL.md`, `references/` and the whole bundle stay within the contract budgets; body ≤ 500 lines | `test/skills-harness.test.ts` |');
lines.push('');
lines.push('## Per skill');
lines.push('');
lines.push('| Skill | Version | Mutating | Cases (by class) | Trigger prompts (+ / − / sibling) | SKILL.md | References | Bundle | Verified content digest |');
lines.push('|---|---|---|---|---|---|---|---|---|');
for (const e of entries) {
  const ev = e.evaluations;
  const cls = Object.entries(ev.by_class).map(([k, v]) => `${k} ${v}`).join(', ');
  lines.push(`| [\`${e.name}\`](https://github.com/proappstore-online/platform/blob/main/skills/${e.name}/SKILL.md) | ${e.version} | ${e.mutating ? 'yes (dry-run → confirm)' : 'no'} | ${ev.cases} (${cls}) | ${ev.trigger_prompts.positive} / ${ev.trigger_prompts.negative} / ${ev.trigger_prompts.sibling} | ${kb(ev.actual.skill_md_bytes)} of ${kb(ev.budgets.skill_md_bytes)} | ${kb(ev.actual.references_bytes)} of ${kb(ev.budgets.references_bytes)} | ${kb(ev.actual.bundle_bytes)} of ${kb(ev.budgets.bundle_bytes)} | \`${e.digest.slice(0, 12)}\` |`);
}
lines.push('');
lines.push('Property coverage per skill (the test that holds each property):');
lines.push('');
lines.push(`| Skill | ${PROPS.join(' | ')} |`);
lines.push(`|---|${PROPS.map(() => '---').join('|')}|`);
for (const e of entries) lines.push(`| \`${e.name}\` | ${PROPS.map((p) => `\`${e.evaluations.properties[p].split('/').pop()}\``).join(' | ')} |`);
lines.push('');
lines.push('## Release gate');
lines.push('');
lines.push('`scripts/build-skills-manifest.mjs --check` runs in CI (`skills-gate` job) and on `pnpm test` (`test/skills-manifest.test.ts`). It fails when:');
lines.push('');
lines.push('- a bundle lacks `SKILL.md`, `evals/cases.json`, `evals/triggers.json`, `evals/contract.json` or `references/output-template.md`;');
lines.push('- a file is executable outside `scripts/`, binary outside `assets/`, or over the size caps (256 KB binary, 128 KB text);');
lines.push('- any file contains a secret-shaped string;');
lines.push('- a Markdown link points outside the bundle or to a missing file;');
lines.push('- `.claude-plugin/plugin.json` or `marketplace.json` lists a different set of skills than the bundles, or a client row lacks its install / update / uninstall / smoke-evidence fields;');
lines.push('- `skills/index.json` or this page differs from what the bundles produce.');
lines.push('');
lines.push('## Install');
lines.push('');
lines.push('The plugin manifest is [`.claude-plugin/plugin.json`](https://github.com/proappstore-online/platform/blob/main/.claude-plugin/plugin.json) (skills + the MCP endpoint); the client-neutral discovery manifest with per-client install, update and uninstall steps is [`marketplace.json`](https://github.com/proappstore-online/platform/blob/main/marketplace.json); the human-readable version is [`skills/README.md`](https://github.com/proappstore-online/platform/blob/main/skills/README.md).');
lines.push('');
lines.push('## Supported-client smoke evidence');
lines.push('');
{
  const market = JSON.parse(readFileSync(marketPath, 'utf8'));
  const rows = (market.clients ?? []).map((c) => c.smoke_evidence ?? {});
  const passed = rows.filter((r) => r.status === 'passed');
  lines.push(`Everything above is machine-verified in this repository. Evidence that a client loads and runs the skills is a structured record per client in [\`marketplace.json\`](https://github.com/proappstore-online/platform/blob/main/marketplace.json) (\`smoke_evidence\`), filled in by whoever performs the run and validated by the release gate: an \`awaiting-run\` row is honest, while a \`passed\` row must carry every required field. Currently **${passed.length} of ${rows.length}** client rows have passed smoke evidence.`);
  lines.push('');
  lines.push('| Client | Status | Date | Runner | Skill | Outcome |');
  lines.push('|---|---|---|---|---|---|');
  for (const r of rows) lines.push(`| ${r.client ?? '?'} | ${r.status ?? '?'} | ${r.date || '—'} | ${r.runner || '—'} | ${r.skill || '—'} | ${r.outcome || '—'} |`);
  lines.push('');
  lines.push('Required fields of a passed row (the gate refuses a passed row missing any):');
  lines.push('');
  lines.push('| Field | Meaning |');
  lines.push('|---|---|');
  for (const [k, v] of Object.entries(market.smoke_evidence_schema?.fields ?? {})) lines.push(`| \`${k}\`${(market.smoke_evidence_schema?.required ?? []).includes(k) ? '' : ' (recommended)'} | ${v} |`);
}
lines.push('');
const summaryMd = `${lines.join('\n')}\n`;

if (problems.length) {
  for (const p of problems) console.error(`✗ ${p}`);
  process.exit(1);
}
if (CHECK) {
  const drift = [];
  if (!existsSync(INDEX) || readFileSync(INDEX, 'utf8') !== indexJson) drift.push('skills/index.json');
  if (!existsSync(SUMMARY) || readFileSync(SUMMARY, 'utf8') !== summaryMd) drift.push('docs/skills/evaluations.md');
  if (drift.length) {
    console.error(`✗ out of date: ${drift.join(', ')} — run: node scripts/build-skills-manifest.mjs`);
    process.exit(1);
  }
  console.log(`✓ ${entries.length} skill bundle(s) valid; skills/index.json and docs/skills/evaluations.md are up to date`);
} else {
  writeFileSync(INDEX, indexJson);
  writeFileSync(SUMMARY, summaryMd);
  console.log(`wrote skills/index.json (${entries.length} skills) and docs/skills/evaluations.md`);
}
