import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validate } from './lib/validate-json-schema.js';

/**
 * Cross-skill evaluation harness (#176). Deterministic — no model calls:
 * triggering is scored from metadata.triggers over fixture prompts, tool
 * order is parsed from the workflow steps, rules and budgets come from each
 * skill's evals/contract.json, and every fixture file is validated against
 * skills/evals.schema.json. Per-skill content checks (citations, fabricated
 * APIs) live in the skills-*.evals tests; structural checks in skills.test.ts.
 */
const ROOT = resolve(__dirname, '..');
const SKILLS = join(ROOT, 'skills');
const SCHEMA = JSON.parse(readFileSync(join(SKILLS, 'evals.schema.json'), 'utf8'));

interface Contract {
  skill: string; mutating: boolean; allowed_tools: string[];
  rules: { rerun: string; stop_or_rollback: string };
  budgets: { skill_md_bytes: number; references_bytes: number; bundle_bytes: number };
  output_sections: string[]; example_markers: string[]; properties: Record<string, string>;
}
interface Triggers { positive: string[]; negative: string[]; sibling: Array<{ prompt: string; skill: string }> }
interface Skill {
  name: string; dir: string; raw: string; body: string; description: string; triggers: string[]; allowed: string[];
  contract: Contract; triggerFixtures: Triggers; cases: Array<{ id: string; class: string }>;
}

function frontmatter(raw: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(raw)!;
  const out: Record<string, string> = {};
  for (const line of m[1]!.split('\n')) { const kv = /^\s*([A-Za-z-]+):\s*(.*)$/.exec(line); if (kv) out[kv[1]!] = kv[2]!.replace(/^"|"$/g, ''); }
  return out;
}
const skills: Skill[] = readdirSync(SKILLS).filter((d) => statSync(join(SKILLS, d)).isDirectory()).map((dir) => {
  const raw = readFileSync(join(SKILLS, dir, 'SKILL.md'), 'utf8');
  const fm = frontmatter(raw);
  return {
    name: fm.name!, dir, raw, body: raw.slice(raw.indexOf('\n---\n') + 5), description: fm.description!,
    triggers: (fm.triggers ?? '').split(',').map((t) => t.trim()).filter(Boolean),
    allowed: (fm['allowed-tools'] ?? '').split(/\s+/).filter(Boolean),
    contract: JSON.parse(readFileSync(join(SKILLS, dir, 'evals', 'contract.json'), 'utf8')),
    triggerFixtures: JSON.parse(readFileSync(join(SKILLS, dir, 'evals', 'triggers.json'), 'utf8')),
    cases: JSON.parse(readFileSync(join(SKILLS, dir, 'evals', 'cases.json'), 'utf8')).cases,
  };
});
const byName = new Map(skills.map((s) => [s.name, s]));

/** MCP tools, and which of them mutate (provisioners) vs read. */
const TOOLS = new Set(
  readdirSync(join(ROOT, 'packages/mcp/src')).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .flatMap((f) => [...readFileSync(join(ROOT, 'packages/mcp/src', f), 'utf8').matchAll(/server\.tool\(\s*["']([a-z_]+)["']/g)].map((m) => m[1]!)),
);
const MUTATING = new Set(['provision_pas_app', 'scaffold_app', 'qa_run']);
const INFO_TOOLS = new Set(['whoami', 'app_info', 'list_templates', 'list_apps']);

// ── triggering: deterministic scorer ─────────────────────────────────────
// A prompt is in-domain when it names the platform. A skill scores the total
// word count of its *specific* trigger phrases found in the prompt; phrases
// that only name the domain carry no weight. Longer phrases are more specific.
const DOMAIN_RE = /proappstore|pro app store|\bpas\b/i;
const isDomainOnly = (t: string) => /^(new )?proappstore( app)?$/i.test(t);
function score(prompt: string, s: Skill): number {
  if (!DOMAIN_RE.test(prompt)) return 0;
  const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return s.triggers.filter((t) => !isDomainOnly(t)).reduce((n, t) => n + (new RegExp(`\\b${esc(t)}\\b`, 'i').test(prompt) ? t.split(/\s+/).length : 0), 0);
}
function route(prompt: string): { winner: string | null; scores: Record<string, number> } {
  const scores = Object.fromEntries(skills.map((s) => [s.name, score(prompt, s)]));
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (ranked[0]![1] === 0) return { winner: null, scores };
  if (ranked[1] && ranked[1][1] === ranked[0]![1]) return { winner: null, scores };
  return { winner: ranked[0]![0], scores };
}

describe('skills harness: fixtures conform to skills/evals.schema.json', () => {
  it.each(skills)('$name: cases.json, triggers.json and contract.json validate', (s) => {
    const cases = JSON.parse(readFileSync(join(SKILLS, s.dir, 'evals', 'cases.json'), 'utf8'));
    expect(validate(SCHEMA, cases)).toEqual([]);
    expect(validate({ $ref: '#/$defs/triggers' }, s.triggerFixtures as never, SCHEMA)).toEqual([]);
    expect(validate({ $ref: '#/$defs/contract' }, s.contract as never, SCHEMA)).toEqual([]);
    expect(s.contract.skill).toBe(s.name);
    for (const [prop, file] of Object.entries(s.contract.properties)) expect(existsSync(join(ROOT, file)), `${s.name}: ${prop} → ${file}`).toBe(true);
  });
});

describe('skills harness: triggering', () => {
  it('every specific trigger phrase belongs to exactly one skill', () => {
    const owners = new Map<string, string[]>();
    for (const s of skills) for (const t of s.triggers) if (!isDomainOnly(t)) owners.set(t.toLowerCase(), [...(owners.get(t.toLowerCase()) ?? []), s.name]);
    for (const [t, o] of owners) expect(o, `trigger "${t}" is claimed by ${o.join(', ')}`).toHaveLength(1);
    for (const s of skills) expect(s.triggers.filter((t) => !isDomainOnly(t)).length, `${s.name} has no specific trigger`).toBeGreaterThanOrEqual(3);
  });

  it.each(skills)('$name: every positive prompt routes to this skill and no other', (s) => {
    for (const p of s.triggerFixtures.positive) {
      const r = route(p);
      expect(r.winner, `"${p}" → ${JSON.stringify(r.scores)}`).toBe(s.name);
    }
  });

  it.each(skills)('$name: every negative prompt routes to no skill', (s) => {
    for (const p of s.triggerFixtures.negative) {
      const r = route(p);
      expect(r.winner, `"${p}" → ${JSON.stringify(r.scores)}`).toBeNull();
    }
  });

  it.each(skills)('$name: every sibling prompt routes to the named sibling, not here', (s) => {
    for (const { prompt, skill } of s.triggerFixtures.sibling) {
      expect(byName.has(skill), `unknown sibling ${skill}`).toBe(true);
      expect(skill).not.toBe(s.name);
      const r = route(prompt);
      expect(r.winner, `"${prompt}" → ${JSON.stringify(r.scores)}`).toBe(skill);
    }
  });

  it('no positive prompt of one skill is ambiguous with another skill (pairwise)', () => {
    for (const a of skills) for (const p of a.triggerFixtures.positive) {
      const { scores } = route(p);
      const top = scores[a.name]!;
      for (const b of skills) if (b !== a) expect(scores[b.name]!, `"${p}": ${a.name}=${top} vs ${b.name}=${scores[b.name]}`).toBeLessThan(top);
    }
  });
});

describe('skills harness: tool selection and order', () => {
  it.each(skills)('$name: workflow steps name only allow-listed tools, reads before mutations, an info tool first', (s) => {
    expect([...s.allowed].sort()).toEqual([...s.contract.allowed_tools].sort());
    const workflow = s.body.slice(s.body.indexOf('## Workflow'), s.body.indexOf('## Blockers'));
    const steps = workflow.split(/\n### /).slice(1);
    expect(steps.length).toBeGreaterThanOrEqual(5);
    const mentions: Array<{ step: number; tool: string }> = [];
    steps.forEach((text, i) => {
      // A tool named inside a prohibition ("do not call `publish_app`") is not a selection.
      for (const line of text.split('\n')) {
        if (/\b(never|not|instead of|rather than)\b/i.test(line)) continue;
        for (const m of line.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)) if (TOOLS.has(m[1]!)) mentions.push({ step: i + 1, tool: m[1]! });
      }
    });
    expect(mentions.length).toBeGreaterThan(2);
    for (const { step, tool } of mentions) expect(s.allowed, `${s.name} step ${step} names \`${tool}\` outside allowed-tools`).toContain(tool);
    const firstMutation = mentions.find((m) => MUTATING.has(m.tool));
    const firstRead = mentions.find((m) => !MUTATING.has(m.tool));
    const firstInfo = mentions.find((m) => INFO_TOOLS.has(m.tool));
    expect(firstRead, 'a read-only tool is used').toBeTruthy();
    expect(firstInfo, 'an info tool (whoami / app_info / list_templates / list_apps) is used').toBeTruthy();
    if (s.contract.mutating) {
      expect(firstMutation, 'a mutating skill must use its provisioner in the workflow').toBeTruthy();
      expect(firstRead!.step).toBeLessThanOrEqual(firstMutation!.step);
      expect(firstInfo!.step, 'an info tool precedes the first mutation').toBeLessThan(firstMutation!.step);
    } else {
      for (const m of mentions) expect(['provision_pas_app', 'scaffold_app'], `${s.name} step ${m.step} provisions`).not.toContain(m.tool);
      if (firstMutation) expect(firstInfo!.step, 'an info tool precedes qa_run').toBeLessThanOrEqual(firstMutation.step);
    }
  });
});

describe('skills harness: idempotency and failure recovery rules', () => {
  it.each(skills)('$name: declares its rerun rule and its stop-or-rollback rule', (s) => {
    expect(s.body, `rerun rule /${s.contract.rules.rerun}/`).toMatch(new RegExp(s.contract.rules.rerun));
    expect(s.body, `stop/rollback rule /${s.contract.rules.stop_or_rollback}/`).toMatch(new RegExp(s.contract.rules.stop_or_rollback));
    expect(s.body).toMatch(/idempotent/i);
  });
});

describe('skills harness: output schema', () => {
  it.each(skills)('$name: the output template carries every required section and each scenario example carries the markers', (s) => {
    const template = readFileSync(join(SKILLS, s.dir, 'references', 'output-template.md'), 'utf8');
    for (const section of s.contract.output_sections) expect(template, `output-template.md lacks section "${section}"`).toContain(section);
    const examplesPath = join(SKILLS, s.dir, 'references', 'worked-examples.md');
    if (s.contract.example_markers.length === 0) return;
    const examples = readFileSync(examplesPath, 'utf8');
    for (const c of s.cases.filter((c) => c.class === 'scenario')) {
      const i = examples.indexOf(`## ${c.id}`);
      expect(i, `no worked example for ${c.id}`).toBeGreaterThan(-1);
      const ex = examples.slice(i).split(/\n## /)[0]!;
      for (const marker of s.contract.example_markers) expect(ex, `${c.id} lacks "${marker}"`).toContain(marker);
    }
  });
});

describe('skills harness: context size budgets', () => {
  const bytesOf = (dir: string): number => readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? bytesOf(join(dir, e.name)) : statSync(join(dir, e.name)).size), 0);
  it.each(skills)('$name: SKILL.md, references and the whole bundle stay within the contract budgets', (s) => {
    const dir = join(SKILLS, s.dir);
    const skillMd = statSync(join(dir, 'SKILL.md')).size;
    const refs = bytesOf(join(dir, 'references'));
    const bundle = bytesOf(dir);
    expect(skillMd, `SKILL.md ${skillMd} B`).toBeLessThanOrEqual(s.contract.budgets.skill_md_bytes);
    expect(refs, `references ${refs} B`).toBeLessThanOrEqual(s.contract.budgets.references_bytes);
    expect(bundle, `bundle ${bundle} B`).toBeLessThanOrEqual(s.contract.budgets.bundle_bytes);
    // Budgets are limits, not targets: a budget more than 2× the actual size is not a budget.
    expect(s.contract.budgets.bundle_bytes, 'bundle budget is loose').toBeLessThanOrEqual(bundle * 2);
    expect(s.raw.split('\n').length).toBeLessThanOrEqual(500);
  });
});
