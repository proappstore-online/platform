import type { FileSource } from '../lib/file-source.js';
import type { CheckResult, CheckStatus } from '../types.js';

/**
 * ADR-011: React apps style with Tailwind 4 utilities on the PAS tokens, and `index.css`
 * holds only `@import "tailwindcss"`, `@source`, the token blocks, `@theme` and
 * `@layer base` / `@layer components`.
 *
 * Four rules, each with its own severity. The three that bound regressions ship as `warn`
 * and flip to `fail` in one place (RULE_SEVERITY) once the fleet audit is clean (#495).
 *
 *   banned-alias       the old token aliases the design-system lint bans (--bg, --surface, ...)
 *   unlayered-rule     a style rule outside `@layer`, `@theme` and the token blocks
 *   hex-outside-tokens a hard-coded hex colour outside the token blocks / `@theme` / `@media print`
 *   feature-classes    a hand-written class selector: components belong in components, not CSS
 *
 * Apps that do not depend on Tailwind are outside the check (ADR-011).
 */

export type CssRule = 'banned-alias' | 'unlayered-rule' | 'hex-outside-tokens' | 'feature-classes';

/** The only place a rule's severity is decided. `fail` is the end state for the first three (#495). */
export const RULE_SEVERITY: Record<CssRule, CheckStatus> = {
  'banned-alias': 'warn',
  'unlayered-rule': 'warn',
  'hex-outside-tokens': 'warn',
  'feature-classes': 'warn',
};

const BANNED_ALIAS = /(?<![\w-])--(?:bg|surface|border|glass|dock|error)(?![\w-])/g;
const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;
/** `:root`, `html`, and their `[data-theme=…]` forms: where a palette's values live. */
const TOKEN_SELECTOR = /^(?::root|html)?(?:\[data-theme[^\]]*\])?$/;

interface Finding {
  rule: CssRule;
  file: string;
  what: string;
}

/** Comments out, string and `url(...)` contents blanked (an `#id` fragment is not a colour). */
function clean(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/url\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\)/gi, 'url()')
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""');
}

type Context = 'top' | 'layer' | 'print' | 'keyframes' | 'skip';

function isTokenSelector(selector: string): boolean {
  const parts = selector.split(',').map((s) => s.trim());
  return parts.length > 0 && parts.every((p) => p !== '' && TOKEN_SELECTOR.test(p));
}

function classNames(selector: string): string[] {
  return [...selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]!);
}

function scan(css: string, file: string, context: Context, out: Finding[]): void {
  let i = 0;
  while (i < css.length) {
    let j = i;
    while (j < css.length && css[j] !== '{' && css[j] !== ';' && css[j] !== '}') j++;
    const prelude = css.slice(i, j).trim();
    if (j >= css.length || css[j] !== '{') {
      i = j + 1;
      continue;
    }
    let depth = 1;
    let k = j + 1;
    while (k < css.length && depth > 0) {
      if (css[k] === '{') depth++;
      else if (css[k] === '}') depth--;
      k++;
    }
    const body = css.slice(j + 1, k - 1);
    i = k;

    if (prelude.startsWith('@')) {
      const at = /^@([\w-]+)/.exec(prelude)?.[1]?.toLowerCase() ?? '';
      if (at === 'layer') scan(body, file, 'layer', out);
      else if (at === 'media' && /\bprint\b/i.test(prelude)) continue;
      else if (at === 'media' || at === 'supports' || at === 'container') scan(body, file, context, out);
      else if (at === 'keyframes') flagHex(body, file, `@keyframes ${prelude.split(/\s+/)[1] ?? ''}`.trim(), out);
      // @theme, @utility, @property, @font-face, @page: Tailwind/CSS plumbing, never a finding.
      continue;
    }
    if (context === 'print' || context === 'skip') continue;
    if (isTokenSelector(prelude)) continue; // the token blocks: hex and values live here
    if (context === 'top') out.push({ rule: 'unlayered-rule', file, what: prelude.replace(/\s+/g, ' ').slice(0, 60) });
    flagHex(body, file, prelude.replace(/\s+/g, ' ').slice(0, 60), out);
    for (const name of classNames(prelude)) out.push({ rule: 'feature-classes', file, what: `.${name}` });
  }
}

function flagHex(body: string, file: string, where: string, out: Finding[]): void {
  for (const m of body.matchAll(HEX)) out.push({ rule: 'hex-outside-tokens', file, what: `${m[0]} in ${where}` });
}

/** Exported for tests: the findings in one stylesheet. */
export function cssFindings(file: string, raw: string): Finding[] {
  const css = clean(raw);
  const out: Finding[] = [];
  for (const m of css.matchAll(BANNED_ALIAS)) out.push({ rule: 'banned-alias', file, what: m[0] });
  scan(css, file, 'top', out);
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
  if (!(await usesTailwind(source))) {
    return { name, status: 'pass', detail: 'not on Tailwind: outside the ADR-011 rule' };
  }
  const findings: Finding[] = [];
  let files = 0;
  for await (const path of source.list()) {
    if (!path.endsWith('.css') || path.endsWith('.min.css') || /(^|\/)(public|vendor)\//.test(path)) continue;
    const css = await source.read(path);
    if (!css) continue;
    files++;
    findings.push(...cssFindings(path, css));
  }
  if (findings.length === 0) {
    return { name, status: 'pass', detail: `${files} stylesheet${files === 1 ? '' : 's'}: tokens, @theme and layers only` };
  }
  const byRule = new Map<CssRule, Finding[]>();
  for (const f of findings) byRule.set(f.rule, [...(byRule.get(f.rule) ?? []), f]);
  let status: CheckStatus = 'pass';
  const parts: string[] = [];
  for (const rule of ['banned-alias', 'unlayered-rule', 'hex-outside-tokens', 'feature-classes'] as const) {
    const hits = byRule.get(rule);
    if (!hits) continue;
    if (SEVERITY_ORDER[RULE_SEVERITY[rule]] > SEVERITY_ORDER[status]) status = RULE_SEVERITY[rule];
    const distinct = [...new Set(hits.map((h) => h.what))];
    parts.push(`${rule} ${hits.length} (${distinct.slice(0, 3).join(', ')}${distinct.length > 3 ? ', …' : ''})`);
  }
  return {
    name,
    status,
    detail: parts.join('; '),
    suggestions: [
      'Run `pas migrate tailwind-tokens --write`, then move what remains into component className utilities (ADR-011).',
      'Keep index.css to @import "tailwindcss", @source, the token blocks, @theme and @layer base/components.',
      'Branding stays in the token values (--accent: …); migrating changes how tokens are used, not what they are set to.',
    ],
  };
}
