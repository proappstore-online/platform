import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { Command } from 'commander';

/**
 * `pas migrate tailwind-tokens` (#494, epic #496): rewrite long-hand
 * `text-[var(--muted)]` utilities to the token utilities the `@theme inline`
 * block maps (`text-muted`), and inline each banned alias (`--bg`, `--surface`,
 * `--border`, `--error`) by the app's OWN definition of it. Dry-run unless
 * `write` is set.
 */

// The #492 token → Tailwind mapping. Colours become `--color-<token>`; the radius
// and shadow tokens get the `pas` names so they cannot collide with Tailwind's.
const COLOR_TOKENS = ['paper', 'paper-deep', 'ink', 'ink-strong', 'muted', 'line', 'line-strong', 'panel', 'panel-strong', 'panel-quiet', 'accent', 'accent-soft', 'accent-deep', 'success', 'warning', 'danger', 'danger-soft'];
const RADIUS_MAP: Record<string, string> = { radius: 'pas', 'radius-sm': 'pas-sm' };
const SHADOW_MAP: Record<string, string> = { shadow: 'pas' };
const BANNED_ALIASES = ['bg', 'surface', 'border', 'error'];
// Longest first so `border-t` wins over `border`.
const PREFIXES = ['border-t', 'border-r', 'border-b', 'border-l', 'text', 'bg', 'border', 'ring', 'outline', 'fill', 'stroke', 'divide', 'from', 'via', 'to', 'shadow', 'rounded'];

// A whole class token: (variants:)* prefix-[var(--token)] (/opacity)?. The lookbehind and
// lookahead keep it from matching inside a longer token, so a bare '[var(--ink)]' or CSS-in-JS
// `color: var(--ink)` is never touched.
const LONG_HAND = new RegExp(
  `(?<![\\w\\[\\]&>*.#=:/-])((?:[\\w\\[\\]&>*.#=-]+:)*)(${PREFIXES.join('|')})-\\[var\\(--([a-z][\\w-]*)\\)\\](\\/(?:\\d+|\\[[\\w.%]+\\]))?(?![\\w\\[\\]-])`,
  'g',
);

interface FileChange {
  file: string;
  replacements: number;
  diff: string;
}

export interface MigrateResult {
  dir: string;
  write: boolean;
  changes: FileChange[];
  replacements: number;
  /** Tokens left alone (not mapped, or not defined by the app), with use counts. */
  unknownTokens: Record<string, number>;
  inlinedAliases: { alias: string; target: string }[];
  skippedAliases: { alias: string; reason: string }[];
  themeInserted: boolean;
  /** What the codemod cannot fix, for an agent to follow up. */
  report: string[];
}

interface CssDecl { name: string; value: string; start: number; end: number; selectors: string[] }
interface CssRule { selector: string; ancestors: string[] }

/** A small CSS reader: declarations and rules with their enclosing selectors; comments blanked. */
function parseCss(css: string): { decls: CssDecl[]; rules: CssRule[] } {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const decls: CssDecl[] = [];
  const rules: CssRule[] = [];
  const stack: string[] = [];
  let seg = 0;
  let paren = 0;
  let quote = '';
  const statement = (end: number, stop: number) => {
    const raw = text.slice(seg, stop);
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('@')) return;
    const colon = trimmed.indexOf(':');
    if (colon < 0) return;
    const start = seg + raw.indexOf(trimmed);
    decls.push({ name: trimmed.slice(0, colon).trim(), value: trimmed.slice(colon + 1).trim(), start, end, selectors: [...stack] });
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '(') { paren++; continue; }
    if (c === ')') { paren--; continue; }
    if (paren > 0) continue;
    if (c === '{') {
      const selector = text.slice(seg, i).trim();
      stack.push(selector);
      rules.push({ selector, ancestors: [...stack] });
      seg = i + 1;
    } else if (c === ';') {
      statement(i + 1, i);
      seg = i + 1;
    } else if (c === '}') {
      statement(i, i);
      stack.pop();
      seg = i + 1;
    }
  }
  return { decls, rules };
}

const isDark = (selectors: string[]) => selectors.some((s) => /dark/.test(s));
const isTokenSelector = (sel: string) => !!sel && sel.split(',').every((p) => /^(:root|html|body)?(\[data-theme[^\]]*\]|\.dark)?$/.test(p.trim()) && p.trim() !== '');

function listFiles(root: string): string[] {
  return (readdirSync(root, { recursive: true }) as string[])
    .map((f) => f.replace(/\\/g, '/'))
    .filter((f) => !f.split('/').includes('node_modules') && /\.(css|tsx|jsx|ts)$/.test(f))
    .sort();
}

/** The alias → target each banned alias resolves to in this app's own CSS, or why not. */
function resolveAliases(css: string): { inline: Map<string, string>; skipped: { alias: string; reason: string }[] } {
  const { decls } = parseCss(css);
  const inline = new Map<string, string>();
  const skipped: { alias: string; reason: string }[] = [];
  const single = (alias: string) => {
    const mine = decls.filter((d) => d.name === `--${alias}`);
    if (!mine.length) return null;
    const bad = mine.find((d) => !/^var\(--[\w-]+\)$/.test(d.value));
    if (bad) return `resolves to \`${bad.value}\`, not a single token`;
    const targets = (dark: boolean) => [...new Set(mine.filter((d) => isDark(d.selectors) === dark).map((d) => d.value.slice(6, -1)))];
    const light = targets(false);
    const dark = targets(true);
    if (!light.length) return 'defined only in the dark block';
    if (light.length > 1) return `resolves to different tokens in the light rules (${light.map((t) => `--${t}`).join(', ')})`;
    if (dark.length > 1) return `resolves to different tokens in the dark rules (${dark.map((t) => `--${t}`).join(', ')})`;
    if (dark.length && dark[0] !== light[0]) return `resolves to --${light[0]} in light but --${dark[0]} in dark`;
    inline.set(alias, light[0]!);
    return null;
  };
  for (const alias of BANNED_ALIASES) {
    const why = single(alias);
    if (why) skipped.push({ alias: `--${alias}`, reason: why });
  }
  // An alias may point at another alias; follow it, and drop it if that one was skipped.
  for (const [alias, target] of [...inline]) {
    let t = target;
    for (let n = 0; n < 5 && BANNED_ALIASES.includes(t); n++) {
      const next = inline.get(t);
      if (!next) { inline.delete(alias); skipped.push({ alias: `--${alias}`, reason: `points at --${t}, which was skipped` }); t = ''; break; }
      t = next;
    }
    if (t && inline.has(alias)) inline.set(alias, t);
  }
  return { inline, skipped };
}

/** Delete the declarations of the given custom properties, and the line if it is left blank. */
function deleteDecls(css: string, names: Set<string>): string {
  const doomed = parseCss(css).decls.filter((d) => names.has(d.name)).sort((a, b) => b.start - a.start);
  let out = css;
  for (const d of doomed) {
    let from = d.start;
    let to = d.end;
    const lineStart = out.lastIndexOf('\n', from - 1) + 1;
    const lineEnd = out.indexOf('\n', to);
    const lineTail = out.slice(to, lineEnd < 0 ? out.length : lineEnd);
    if (!out.slice(lineStart, from).trim() && !lineTail.trim()) { from = lineStart; to = lineEnd < 0 ? out.length : lineEnd + 1; }
    out = out.slice(0, from) + out.slice(to);
  }
  return out;
}

function themeBlock(defined: Set<string>): string {
  const lines: string[] = [];
  for (const t of COLOR_TOKENS) if (defined.has(t)) lines.push(`  --color-${t}: var(--${t});`);
  for (const [t, n] of Object.entries(RADIUS_MAP)) if (defined.has(t)) lines.push(`  --radius-${n}: var(--${t});`);
  for (const [t, n] of Object.entries(SHADOW_MAP)) if (defined.has(t)) lines.push(`  --shadow-${n}: var(--${t});`);
  return lines.length ? `@theme inline {\n${lines.join('\n')}\n}\n` : '';
}

function insertTheme(css: string, block: string): string | null {
  const lines = css.split('\n');
  let at = -1;
  lines.forEach((l, i) => { if (/^\s*@source\b/.test(l)) at = i; });
  if (at < 0) lines.forEach((l, i) => { if (at < 0 && /^\s*@import\s+["']tailwindcss["']/.test(l)) at = i; });
  if (at < 0) return null;
  lines.splice(at + 1, 0, '', ...block.trimEnd().split('\n'));
  return lines.join('\n');
}

/** Unified diff; edits here are sparse, so a greedy resync is enough. */
function unifiedDiff(file: string, a: string, b: string): string {
  const x = a.split('\n');
  const y = b.split('\n');
  const ops: { t: ' ' | '-' | '+'; s: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) { ops.push({ t: ' ', s: x[i]! }); i++; j++; continue; }
    let del = -1;
    let ins = -1;
    for (let k = 1; k <= 60 && (del < 0 || ins < 0); k++) {
      if (del < 0 && j < y.length && x[i + k] === y[j]) del = k;
      if (ins < 0 && i < x.length && y[j + k] === x[i]) ins = k;
    }
    if (del > 0 && (ins < 0 || del <= ins)) { for (let k = 0; k < del; k++) ops.push({ t: '-', s: x[i++]! }); }
    else if (ins > 0) { for (let k = 0; k < ins; k++) ops.push({ t: '+', s: y[j++]! }); }
    else { if (i < x.length) ops.push({ t: '-', s: x[i++]! }); if (j < y.length) ops.push({ t: '+', s: y[j++]! }); }
  }
  const out = [`--- a/${file}`, `+++ b/${file}`];
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((o, n) => { if (o.t !== ' ') for (let k = Math.max(0, n - 3); k <= Math.min(ops.length - 1, n + 3); k++) keep[k] = true; });
  let n = 0;
  let ai = 1;
  let bi = 1;
  while (n < ops.length) {
    if (!keep[n]) { if (ops[n]!.t !== '+') ai++; if (ops[n]!.t !== '-') bi++; n++; continue; }
    const hunk: string[] = [];
    const sa = ai;
    const sb = bi;
    let ca = 0;
    let cb = 0;
    for (; n < ops.length && keep[n]; n++) {
      const o = ops[n]!;
      hunk.push(o.t + o.s);
      if (o.t !== '+') { ca++; ai++; }
      if (o.t !== '-') { cb++; bi++; }
    }
    out.push(`@@ -${sa},${ca} +${sb},${cb} @@`, ...hunk);
  }
  return out.join('\n') + '\n';
}

/** What the codemod cannot fix in the app's CSS: unlayered rules, hex outside tokens, per-screen dark overrides. */
function detectCssIssues(file: string, css: string): string[] {
  const { decls, rules } = parseCss(css);
  const unlayered = rules.filter((r) => {
    if (r.ancestors.some((a) => /^@(layer|theme|font-face|keyframes|property)\b/.test(a))) return false;
    if (/^@/.test(r.selector)) return false;
    return !isTokenSelector(r.selector);
  });
  const darkOverrides = rules.filter((r) => !r.ancestors.some((a) => /^@layer\b/.test(a)) && !/^@/.test(r.selector) && /dark/.test(r.ancestors.join(' ')) && !isTokenSelector(r.selector));
  const hex = decls.filter((d) => /#[0-9a-f]{3,8}\b/i.test(d.value) && !d.selectors.some((s) => isTokenSelector(s) || /^@(theme|font-face)\b/.test(s)));
  const out: string[] = [];
  if (unlayered.length) out.push(`${file}: ${unlayered.length} unlayered rule(s) outside @layer (e.g. \`${unlayered[0]!.selector}\`); move to a component or @layer base`);
  if (hex.length) out.push(`${file}: ${hex.length} hard-coded hex value(s) outside the token blocks (e.g. \`${hex[0]!.name}: ${hex[0]!.value}\`); use a token`);
  if (darkOverrides.length) out.push(`${file}: ${darkOverrides.length} per-screen dark override(s) (e.g. \`${darkOverrides[0]!.selector}\`); define the token for dark instead`);
  return out;
}

export async function migrateTailwindTokens(opts: { dir: string; write: boolean }): Promise<MigrateResult> {
  const root = resolve(opts.dir);
  const src = join(root, 'web', 'src');
  if (!existsSync(src)) throw new Error(`No web/src under ${root}; pass --dir <app repo root>.`);
  const names = listFiles(src);
  const original = new Map(names.map((f) => [f, readFileSync(join(src, f), 'utf8')]));
  const work = new Map(original);
  const counts = new Map<string, number>();
  const bump = (f: string, n: number) => counts.set(f, (counts.get(f) ?? 0) + n);
  const report: string[] = [];
  const indexCss = 'index.css';

  // 1. Banned aliases, by this app's own definition.
  const hasIndex = work.has(indexCss);
  const { inline, skipped } = hasIndex ? resolveAliases(work.get(indexCss)!) : { inline: new Map<string, string>(), skipped: [] };
  if (inline.size) {
    work.set(indexCss, deleteDecls(work.get(indexCss)!, new Set([...inline.keys()].map((a) => `--${a}`))));
    for (const [f, text] of work) {
      let next = text;
      for (const [alias, target] of inline) {
        const re = new RegExp(`var\\(--${alias}(?=[\\s,)])`, 'g');
        next = next.replace(re, () => { bump(f, 1); return `var(--${target}`; });
      }
      work.set(f, next);
    }
    // A deleted definition counts as a change to index.css even with no other use.
    bump(indexCss, inline.size);
  }
  for (const alias of BANNED_ALIASES) {
    if (inline.has(alias) || skipped.some((s) => s.alias === `--${alias}`)) continue;
    const uses = [...work.values()].reduce((n, t) => n + (t.match(new RegExp(`var\\(--${alias}(?=[\\s,)])`, 'g'))?.length ?? 0), 0);
    if (uses) report.push(`var(--${alias}) is used ${uses} time(s) but index.css does not define it; left as is`);
  }

  // 2. Long-hand utilities → token utilities, for tokens this app defines.
  const defined = new Set<string>();
  for (const [f, text] of work) if (f.endsWith('.css')) for (const d of parseCss(text).decls) if (d.name.startsWith('--')) defined.add(d.name.slice(2));
  const unknown: Record<string, number> = {};
  if (!hasIndex) report.push('web/src/index.css not found; no utilities rewritten');
  for (const [f, text] of work) {
    if (!hasIndex || f.endsWith('.css')) continue;
    work.set(f, text.replace(LONG_HAND, (m, variants: string, prefix: string, token: string, opacity: string | undefined) => {
      let name: string | undefined;
      if (prefix === 'rounded') name = RADIUS_MAP[token] && defined.has(token) ? `rounded-${RADIUS_MAP[token]}` : undefined;
      else if (prefix === 'shadow' && SHADOW_MAP[token]) name = defined.has(token) ? `shadow-${SHADOW_MAP[token]}` : undefined;
      else if (COLOR_TOKENS.includes(token) && defined.has(token)) name = `${prefix}-${token}`;
      if (!name) { unknown[`--${token}`] = (unknown[`--${token}`] ?? 0) + 1; return m; }
      bump(f, 1);
      return `${variants}${name}${opacity ?? ''}`;
    }));
  }

  // 3. The @theme inline block that makes those utilities exist.
  let themeInserted = false;
  if (hasIndex) {
    const css = work.get(indexCss)!;
    if (!/@theme\s+inline\s*\{/.test(css)) {
      const block = themeBlock(defined);
      const next = block ? insertTheme(css, block) : null;
      if (next) { work.set(indexCss, next); themeInserted = true; bump(indexCss, 1); }
      else report.push(block ? 'index.css has no @source or @import "tailwindcss" line to insert @theme inline after' : 'no PAS tokens defined in the app CSS; @theme inline not added');
    }
  }

  // 4. What is left for an agent.
  for (const [f, text] of work) if (f.endsWith('.css')) report.push(...detectCssIssues(f, text));
  for (const [token, n] of Object.entries(unknown)) report.push(`${token}: ${n} long-hand use(s) not rewritten (not in the token mapping or not defined by the app)`);
  for (const s of skipped) report.push(`${s.alias} left in place: ${s.reason}`);

  const changes: FileChange[] = [];
  for (const [f, text] of work) {
    const before = original.get(f)!;
    if (text === before) continue;
    changes.push({ file: relative(root, join(src, f)).replace(/\\/g, '/'), replacements: counts.get(f) ?? 0, diff: unifiedDiff(relative(root, join(src, f)).replace(/\\/g, '/'), before, text) });
    if (opts.write) writeFileSync(join(src, f), text);
  }
  return {
    dir: root,
    write: opts.write,
    changes,
    replacements: changes.reduce((n, c) => n + c.replacements, 0),
    unknownTokens: unknown,
    inlinedAliases: [...inline].map(([alias, target]) => ({ alias: `--${alias}`, target: `--${target}` })),
    skippedAliases: skipped,
    themeInserted,
    report,
  };
}

export const migrateCommand = new Command('migrate').description('Codemods that move an app onto the current PAS standards.');

migrateCommand
  .command('tailwind-tokens')
  .description('Rewrite long-hand Tailwind CSS-variable utilities (text-[var(--muted)]) to token utilities (text-muted) and inline banned aliases. Dry-run unless --write.')
  .option('--dir <path>', 'app repo root', '.')
  .option('--write', 'apply the changes (default: print the diff and change nothing)')
  .action(async (opts: { dir: string; write?: boolean }) => {
    const r = await migrateTailwindTokens({ dir: opts.dir, write: !!opts.write });
    const out = process.stdout;
    if (!r.write) for (const c of r.changes) out.write(c.diff);
    for (const c of r.changes) out.write(`${c.file}: ${c.replacements} change(s)\n`);
    for (const a of r.inlinedAliases) out.write(`alias ${a.alias} → var(${a.target}), definition removed\n`);
    if (r.themeInserted) out.write('inserted @theme inline into web/src/index.css\n');
    for (const line of r.report) out.write(`left for follow-up: ${line}\n`);
    out.write(r.write ? `\nWrote ${r.changes.length} file(s), ${r.replacements} change(s).\n` : `\nDry run: ${r.changes.length} file(s), ${r.replacements} change(s) would be made. Re-run with --write to apply.\n`);
  });
