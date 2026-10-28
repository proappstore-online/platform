import type { FileSource } from '../lib/file-source.js';
import { isGameProject } from '../lib/project-type.js';
import { stripCssComments } from '../lib/strip.js';
import type { CheckResult, CheckStatus } from '../types.js';

/**
 * ADR-011: React apps style with Tailwind 4 utilities on the PAS tokens, and `index.css`
 * holds only `@import "tailwindcss"`, `@source`, the token blocks, `@theme` and
 * `@layer base` / `@layer components`.
 *
 * Five rules, each with its own severity. Every rule ships as `warn`; RULE_SEVERITY is the
 * single place the three regression bounds flip to `fail` once the fleet audit is clean (#495).
 *
 *   banned-alias            exactly --bg, --surface, --border, --glass, --dock, --error, defined or used.
 *                           Whole-name match: compound app tokens (--surface-soft) are legitimate.
 *   unlayered-rule          a style rule outside `@layer`, `@theme`, the token blocks and `@media print`
 *   hex-outside-tokens      #rgb / #rrggbb / rgb() / rgba() literals outside the token blocks and `@theme`
 *   per-screen-dark-override  `:root[data-theme='dark'] .something`: dark mode must come from the tokens
 *   feature-classes         distinct class selectors defined in CSS, warned above FEATURE_CLASS_BUDGET
 *
 * Apps with no Tailwind dependency are outside the check (ADR-011), and so are game projects.
 *
 * The stylesheet is read with a small brace-matching scanner, not a CSS parser dependency: the
 * package has no runtime dependencies, and the only structure the rules need is at-rule nesting
 * (a `@media` inside an `@layer` is classified by where it sits). Comments are stripped
 * position-preservingly, so every finding carries a real file:line.
 */

export type CssRule = 'banned-alias' | 'unlayered-rule' | 'hex-outside-tokens' | 'per-screen-dark-override' | 'feature-classes';

/** The only place a rule's severity is decided. `fail` is the end state for the first three (#495). */
export const RULE_SEVERITY: Record<CssRule, CheckStatus> = {
  'banned-alias': 'warn',
  'unlayered-rule': 'warn',
  'hex-outside-tokens': 'warn',
  'per-screen-dark-override': 'warn',
  'feature-classes': 'warn',
};

/** `hiring`, the cleanest recent app, defines 8. */
export const FEATURE_CLASS_BUDGET = 15;

const RULE_ORDER: readonly CssRule[] = ['banned-alias', 'unlayered-rule', 'hex-outside-tokens', 'per-screen-dark-override', 'feature-classes'];

const BANNED_ALIAS = /(?<![\w-])--(?:bg|surface|border|glass|dock|error)(?![\w-])/g;
const COLOUR_LITERAL = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])|\brgba?\(\s*\d/g;
/** `:root` / `html` with data-attribute variants (`[data-theme=…]`, `[data-text-size=…]`), and a bare `[data-theme=…]`: where a palette's values live. */
const TOKEN_SELECTOR = /^(?:(?::root|html)(?:\[data-[\w-]+[^\]]*\])*|\[data-theme[^\]]*\])$/;
/** A dark-theme selector followed by anything else: `:root[data-theme='dark'] .ledger`. */
const DARK_DESCENDANT = /(?:^|[\s,])(?::root|html)?\[data-theme\s*[~|^$*]?=\s*["']?dark["']?\]\s*[>+~]?\s*[.#\w[:*]/i;

export interface Finding {
  rule: CssRule;
  file: string;
  line: number;
  what: string;
}

const spaces = (s: string) => s.replace(/[^\n]/g, ' ');
/** `url(...)` blanked to spaces, length kept: an `#id` fragment is not a colour. */
const blankUrls = (css: string): string => css.replace(/url\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\)/gi, spaces);
/** Strings blanked too, for declaration bodies only: a selector's `[data-theme='dark']` must stay readable. */
const blankStrings = (css: string): string => css.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, spaces);

type Context = 'top' | 'layer';

function isTokenSelector(selector: string): boolean {
  const parts = selector.split(',').map((s) => s.trim());
  return parts.length > 0 && parts.every((p) => p !== '' && TOKEN_SELECTOR.test(p));
}

function classNames(selector: string): string[] {
  return [...selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]!);
}

interface Scan {
  css: string;
  file: string;
  lineAt: (offset: number) => number;
  out: Finding[];
}

const short = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 60);

function scan(s: Scan, from: number, to: number, context: Context): void {
  const { css } = s;
  let i = from;
  while (i < to) {
    let j = i;
    while (j < to && css[j] !== '{' && css[j] !== ';' && css[j] !== '}') j++;
    const prelude = css.slice(i, j).trim();
    const start = i + (css.slice(i, j).length - css.slice(i, j).trimStart().length);
    if (j >= to || css[j] !== '{') {
      i = j + 1;
      continue;
    }
    let depth = 1;
    let k = j + 1;
    while (k < to && depth > 0) {
      if (css[k] === '{') depth++;
      else if (css[k] === '}') depth--;
      k++;
    }
    const bodyFrom = j + 1;
    const bodyTo = k - 1;
    i = k;

    if (prelude.startsWith('@')) {
      const at = /^@([\w-]+)/.exec(prelude)?.[1]?.toLowerCase() ?? '';
      if (at === 'layer') scan(s, bodyFrom, bodyTo, 'layer');
      else if (at === 'media' && /\bprint\b/i.test(prelude)) continue;
      else if (at === 'media' || at === 'supports' || at === 'container') scan(s, bodyFrom, bodyTo, context);
      else if (at === 'keyframes') flagColours(s, bodyFrom, bodyTo, prelude);
      // @theme, @utility, @property, @font-face, @page: plumbing, never a finding.
      continue;
    }
    const line = s.lineAt(start);
    if (DARK_DESCENDANT.test(prelude)) s.out.push({ rule: 'per-screen-dark-override', file: s.file, line, what: short(prelude) });
    if (isTokenSelector(prelude)) continue; // the token blocks: colour literals live here
    if (context === 'top') s.out.push({ rule: 'unlayered-rule', file: s.file, line, what: short(prelude) });
    flagColours(s, bodyFrom, bodyTo, prelude);
    for (const name of classNames(prelude)) s.out.push({ rule: 'feature-classes', file: s.file, line, what: `.${name}` });
  }
}

function flagColours(s: Scan, from: number, to: number, where: string): void {
  const body = blankStrings(s.css.slice(from, to));
  for (const m of body.matchAll(COLOUR_LITERAL)) {
    s.out.push({ rule: 'hex-outside-tokens', file: s.file, line: s.lineAt(from + (m.index ?? 0)), what: `${m[0].trim()} in ${short(where)}` });
  }
}

/** Exported for tests: the findings in one stylesheet. */
export function cssFindings(file: string, raw: string): Finding[] {
  const css = blankUrls(stripCssComments(raw));
  const newlines: number[] = [];
  for (let i = 0; i < css.length; i++) if (css[i] === '\n') newlines.push(i);
  const lineAt = (offset: number) => {
    let lo = 0;
    let hi = newlines.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (newlines[mid]! < offset) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  };
  const out: Finding[] = [];
  for (const m of css.matchAll(BANNED_ALIAS)) out.push({ rule: 'banned-alias', file, line: lineAt(m.index ?? 0), what: m[0] });
  scan({ css, file, lineAt, out }, 0, css.length, 'top');
  return out;
}

async function usesTailwind(source: FileSource): Promise<boolean> {
  for (const path of ['web/package.json', 'package.json']) {
    const text = await source.read(path);
    if (!text) continue;
    try {
      const pkg = JSON.parse(text) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.tailwindcss || deps['@tailwindcss/vite'] || deps['@tailwindcss/postcss']) return true;
    } catch {
      // unreadable package.json: not evidence either way
    }
  }
  return false;
}

const SEVERITY_ORDER: Record<CheckStatus, number> = { pass: 0, warn: 1, fail: 2 };

export async function checkCssDiscipline(source: FileSource): Promise<CheckResult> {
  const name = 'CSS discipline';
  if (await isGameProject(source)) return { name, status: 'pass', detail: 'game project: outside the ADR-011 rule' };
  if (!(await usesTailwind(source))) {
    return { name, status: 'pass', detail: 'not on Tailwind: outside the ADR-011 rule' };
  }
  const findings: Finding[] = [];
  let files = 0;
  for await (const path of source.list()) {
    // `marketing/` is a separate Astro site with its own stylesheet, not the app's (#408); public/ and vendor/ are not authored CSS.
    if (!path.endsWith('.css') || path.endsWith('.min.css') || /(^|\/)(public|vendor|marketing)\//.test(path)) continue;
    const css = await source.read(path);
    if (!css) continue;
    files++;
    findings.push(...cssFindings(path, css));
  }

  // The class budget is a count of distinct names across the app, not one finding per class.
  const classes = [...new Set(findings.filter((f) => f.rule === 'feature-classes').map((f) => f.what))];
  const reported = findings.filter((f) => f.rule !== 'feature-classes');
  if (classes.length > FEATURE_CLASS_BUDGET) {
    const first = findings.find((f) => f.rule === 'feature-classes');
    reported.push({ rule: 'feature-classes', file: first?.file ?? '', line: first?.line ?? 1, what: `${classes.length} classes (budget ${FEATURE_CLASS_BUDGET})` });
  }

  if (reported.length === 0) {
    return { name, status: 'pass', detail: `${files} stylesheet${files === 1 ? '' : 's'}: tokens, @theme and layers only` };
  }
  let status: CheckStatus = 'pass';
  const parts: string[] = [];
  for (const rule of RULE_ORDER) {
    const hits = reported.filter((f) => f.rule === rule);
    if (hits.length === 0) continue;
    if (SEVERITY_ORDER[RULE_SEVERITY[rule]] > SEVERITY_ORDER[status]) status = RULE_SEVERITY[rule];
    const examples = hits.slice(0, 3).map((h) => `${h.file}:${h.line} ${h.what}`);
    parts.push(`${rule} ${hits.length} (${examples.join(', ')}${hits.length > 3 ? ', …' : ''})`);
  }
  return {
    name,
    status,
    detail: parts.join('; '),
    suggestions: [
      'Run `pas migrate tailwind-tokens --write`, then move what remains into component className utilities (ADR-011, https://docs.proappstore.online/ui/#styling).',
      'Keep index.css to @import "tailwindcss", @source, the token blocks, @theme and @layer base/components.',
      'Branding stays in the token values (--accent: …); migrating changes how tokens are used, not what they are set to.',
    ],
  };
}
