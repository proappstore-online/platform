import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Agent Skills validation (#170, foundation for #169; generalised for #171). Every directory under
 * skills/ must be a spec-conformant skill (https://agentskills.io/specification):
 * frontmatter shape, name = directory, narrow description, short body, live
 * file references, a minimal MCP-only allow-list, no secrets, no duplicate
 * names — plus the content contracts this repo adds (tools named in the body
 * exist, docs links resolve, dry-run precedes confirm, evaluations cover every
 * blocker class).
 */
const ROOT = resolve(__dirname, '..');
const SKILLS = join(ROOT, 'skills');
const DOCS = join(ROOT, 'docs');

interface Skill { dir: string; name: string; fm: Record<string, string>; metadata: Record<string, string>; body: string; raw: string }

function parseFrontmatter(raw: string): { fm: Record<string, string>; metadata: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!m) throw new Error('no frontmatter');
  const fm: Record<string, string> = {}; const metadata: Record<string, string> = {};
  let inMeta = false;
  for (const line of m[1]!.split('\n')) {
    if (/^metadata:\s*$/.test(line)) { inMeta = true; continue; }
    const nested = /^  ([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (inMeta && nested) { metadata[nested[1]!] = nested[2]!.replace(/^"|"$/g, ''); continue; }
    inMeta = false;
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) fm[kv[1]!] = kv[2]!;
  }
  return { fm, metadata, body: m[2]! };
}

const skillDirs = existsSync(SKILLS)
  ? readdirSync(SKILLS).filter((d) => statSync(join(SKILLS, d)).isDirectory())
  : [];
const skills: Skill[] = skillDirs.map((dir) => {
  const raw = readFileSync(join(SKILLS, dir, 'SKILL.md'), 'utf8');
  const { fm, metadata, body } = parseFrontmatter(raw);
  return { dir, name: fm.name ?? '', fm, metadata, body, raw };
});

/** Real MCP tool names, from every `server.tool(` registration in packages/mcp/src. */
function mcpToolNames(): Set<string> {
  const dir = join(ROOT, 'packages/mcp/src');
  const names = new Set<string>();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
    const src = readFileSync(join(dir, f), 'utf8');
    for (const m of src.matchAll(/server\.tool\(\s*["']([a-z_]+)["']/g)) names.add(m[1]!);
  }
  return names;
}
const TOOLS = mcpToolNames();
/** Mutating tools a skill may never pre-approve, except the two provisioners. */
const FORBIDDEN_TOOL_RE = /^(write_|delete_|set_|batch_write|publish_app$|provision_app$|create_app$|deploy_project$|add_ticket$|update_ticket$|run_tests$|qa_save_flow$|qa_delete_flow$|qa_mint_key$|build_knowledge_base$|chat_agent$|write_project_files$|delete_project_files$)/;
const PROVISIONERS = new Set(['provision_pas_app', 'scaffold_app']);
/** A skill "mutates" when it pre-approves a provisioner; advisory skills are read-only. */
const mutates = (s: Skill) => (s.fm['allowed-tools'] ?? '').split(/\s+/).some((t) => PROVISIONERS.has(t));
/** Tool parameters and /v1/provision step names that legitimately appear in backticks. */
const PARAMS = new Set(['app_id', 'template_repo', 'allow_unapproved_template', 'private_repo', 'reuse_existing_repo', 'skip_compliance', 'dry_run', 'template_id', 'template_rev', 'known_deviations', 'security_compliance', 'include_deprecated', 'confirm', 'verify', 'create_d1', 'deploy_worker', 'record_app', 'app_roles', 'platform_roles', 'caller_unscoped', 'requires_auth']);
/** `sdk_reference` feature names, read from the tool's enum. */
function sdkFeatures(): Set<string> {
  const src = readFileSync(join(ROOT, 'packages/mcp/src/platform-tools.ts'), 'utf8');
  const m = /feature:\s*z\.enum\(\[([\s\S]*?)\]\)/.exec(src);
  if (!m) throw new Error('sdk_reference feature enum not found');
  return new Set([...m[1]!.matchAll(/"([a-z_]+)"/g)].map((x) => x[1]!));
}
const SDK_FEATURES = sdkFeatures();
const SECRET_RE = /(sk-[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|\bBearer\s+[A-Za-z0-9._-]{16,}|\b[0-9a-f]{32,}\b|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY)/;

function skillFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(join(d, e.name)) : out.push(join(d, e.name)); };
  walk(join(SKILLS, dir));
  return out;
}

function docsFileFor(url: string): string | null {
  const u = new URL(url);
  if (u.hostname !== 'docs.proappstore.online') return null;
  const p = u.pathname.replace(/^\//, '');
  if (p === '') return join(DOCS, 'index.md');
  if (/\.[a-z]+$/.test(p)) return join(DOCS, p);
  const base = p.replace(/\/$/, '');
  const asIndex = join(DOCS, base, 'index.md');
  return existsSync(asIndex) ? asIndex : join(DOCS, `${base}.md`);
}

describe('skills: layout', () => {
  it('has at least one skill and every skill directory has a SKILL.md', () => {
    expect(skillDirs.length).toBeGreaterThan(0);
    for (const d of skillDirs) expect(existsSync(join(SKILLS, d, 'SKILL.md')), `${d}/SKILL.md`).toBe(true);
  });

  it('skill names are unique across skills/', () => {
    expect(new Set(skills.map((s) => s.name)).size).toBe(skills.length);
  });
});

describe.each(skills)('skill $dir', (s) => {
  it('frontmatter: name matches the directory and the spec grammar', () => {
    expect(s.name).toBe(s.dir);
    expect(s.name.length).toBeLessThanOrEqual(64);
    expect(s.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('frontmatter: description is 1–1024 chars, says what and when, and carries the trigger keywords', () => {
    const d = s.fm.description ?? '';
    expect(d.length).toBeGreaterThan(0);
    expect(d.length).toBeLessThanOrEqual(1024);
    expect(d).toMatch(/Use when/i);
    // Each skill declares its own trigger phrases in metadata.triggers; the
    // description must carry every one so clients match narrowly on them.
    const triggers = (s.metadata.triggers ?? '').split(',').map((t) => t.trim()).filter(Boolean);
    expect(triggers.length, 'metadata.triggers is required').toBeGreaterThan(0);
    for (const kw of triggers) expect(d.toLowerCase(), `description lacks trigger "${kw}"`).toContain(kw.toLowerCase());
    expect(s.fm.license).toBe('MIT');
    expect(s.metadata.author).toBeTruthy();
    expect(s.metadata.version).toMatch(/^\d+\.\d+$/);
    expect(s.metadata['mcp-endpoint']).toBe('https://mcp.proappstore.online/mcp');
    if (s.fm.compatibility) expect(s.fm.compatibility.length).toBeLessThanOrEqual(500);
  });

  it('body stays under the progressive-disclosure limit (500 lines)', () => {
    expect(s.raw.split('\n').length).toBeLessThanOrEqual(500);
  });

  it('every relative file reference resolves inside the skill', () => {
    const dir = join(SKILLS, s.dir);
    for (const m of s.body.matchAll(/\]\(([^)\s]+)\)/g)) {
      const t = m[1]!;
      if (/^(https?:|mailto:|#)/.test(t)) continue;
      expect(existsSync(resolve(dir, t.split('#')[0]!)), `${s.dir}: ${t}`).toBe(true);
    }
  });

  it('allowed-tools is a minimal MCP-only allow-list: real tool names, no mutators except the provisioners', () => {
    const allowed = (s.fm['allowed-tools'] ?? '').split(/\s+/).filter(Boolean);
    expect(allowed.length).toBeGreaterThan(0);
    for (const t of allowed) {
      expect(TOOLS.has(t), `${t} is not a registered MCP tool`).toBe(true);
      if (!PROVISIONERS.has(t)) expect(FORBIDDEN_TOOL_RE.test(t), `${t} is a mutating tool and may not be pre-approved`).toBe(false);
    }
    for (const bad of ['write_file', 'delete_file', 'set_model', 'batch_write_files', 'publish_app']) expect(allowed).not.toContain(bad);
  });

  it('names only MCP tools that exist', () => {
    // Backticked snake_case identifiers that are not tool *parameters* (or
    // sdk_reference feature names) must be registered MCP tools — a skill that
    // names a tool the server lacks sends the agent down a dead end.
    const named = [...s.body.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]!).filter((n) => !PARAMS.has(n) && !SDK_FEATURES.has(n));
    for (const n of new Set(named)) expect(TOOLS.has(n), `body names unknown tool \`${n}\``).toBe(true);
  });

  it(mutates(s) ? 'mandates dry_run before confirm and degrades in read-only mode' : 'is read-only: pre-approves no mutating tool and never asks to confirm a write', () => {
    if (mutates(s)) {
      // In the workflow itself the dry-run step must come before the confirmed run.
      const workflow = s.body.slice(s.body.indexOf('## Workflow'));
      const dry = workflow.indexOf('dry_run: true');
      const confirm = workflow.indexOf('confirm: true');
      expect(dry).toBeGreaterThan(-1);
      expect(confirm).toBeGreaterThan(dry);
      expect(s.body).toMatch(/Never call `provision_pas_app` with\s+`confirm: true` until/);
      expect(s.body).toMatch(/read-only mode/i);
      expect(s.body).toMatch(/known deviations/i);
    } else {
      expect(s.body).not.toMatch(/confirm: true/);
      expect(s.body).toMatch(/read-only/i);
      expect(s.fm.compatibility ?? '').toMatch(/read-only/i);
    }
  });

  it('never handles credentials or infrastructure directly', () => {
    expect(s.body).not.toMatch(/PAS_SESSION_TOKEN=/);
    // Infrastructure commands, tokens and .env files may be mentioned only as prohibitions.
    for (const para of s.body.split(/\n\s*\n/)) {
      if (/wrangler|gh repo create|\.env\b|tokens?\b/i.test(para)) expect(para, `${s.dir}: paragraph mentions credentials/infra without forbidding it: "${para.trim().slice(0, 80)}…"`).toMatch(/\b(no|never|not|stop)\b|does not|blocker/i);
    }
    expect(s.body).toMatch(/never handle credentials/i);
  });

  it('every docs.proappstore.online link maps to a docs/ file', () => {
    for (const f of skillFiles(s.dir)) {
      for (const m of readFileSync(f, 'utf8').matchAll(/https:\/\/docs\.proappstore\.online\/[^\s)`"'<>]*/g)) {
        const file = docsFileFor(m[0]);
        expect(file && existsSync(file), `${f}: ${m[0]}`).toBe(true);
      }
    }
  });

  it('contains no secret-shaped strings', () => {
    for (const f of skillFiles(s.dir)) {
      const text = readFileSync(f, 'utf8');
      const hit = SECRET_RE.exec(text);
      // 40-hex git commit ids are provenance, not secrets: allow exactly those.
      if (hit && !/^[0-9a-f]{40}$/.test(hit[0])) expect.fail(`${f}: secret-shaped string ${hit[0].slice(0, 12)}…`);
    }
  });

  it('ships evaluation fixtures covering every blocker class named in negative-cases.md', () => {
    const evalsPath = join(SKILLS, s.dir, 'evals', 'cases.json');
    expect(existsSync(evalsPath)).toBe(true);
    const cases = JSON.parse(readFileSync(evalsPath, 'utf8')).cases as Array<{ id: string; class: string; blocker?: string }>;
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    for (const c of cases) expect(c.class, `${c.id} has no class`).toBeTruthy();
    // Provisioning skills exercise the whole mutating lifecycle; advisory
    // skills need their scenarios plus every blocker.
    const required = mutates(s) ? ['happy', 'template', 'confirm', 'rerun', 'blocker'] : ['scenario', 'blocker'];
    for (const cls of required) expect(cases.some((c) => c.class === cls), `no ${cls} case`).toBe(true);
    const negatives = readFileSync(join(SKILLS, s.dir, 'references', 'negative-cases.md'), 'utf8');
    // "Blocker: **class**" (optionally "class/qualifier") in negative-cases.md.
    const classes = new Set([...negatives.matchAll(/Blocker[^*]{0,40}\*\*([a-z-]+)/g)].map((m) => m[1]!));
    expect(classes.size, `${s.dir}: negative-cases.md names no blocker class`).toBeGreaterThan(0);
    for (const b of classes) expect(cases.some((c) => c.class === 'blocker' && c.blocker === b), `no fixture for blocker class ${b}`).toBe(true);
  });
});
