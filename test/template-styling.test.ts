import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// #492 (ADR-011): every template maps the PAS tokens to Tailwind colours with `@theme inline`, writes its components in the mapped
// utilities, and tells the agent how to style. `inline` is what keeps `var(--ink)` in the generated class so dark mode still switches it.

const ROOT = join(import.meta.dirname, '..');
const TEMPLATES = ['template-workspace', 'template-map', 'template-membership'];
const read = (...p: string[]) => readFileSync(join(ROOT, 'templates', ...p), 'utf8');

const MAPPED_COLOURS = ['paper', 'paper-deep', 'ink', 'ink-strong', 'muted', 'line', 'line-strong', 'panel', 'panel-strong', 'panel-quiet', 'accent', 'accent-soft', 'accent-deep', 'success', 'warning', 'danger', 'danger-soft'];
const BANNED_ARBITRARY = /\[var\(--(ink|muted|line|line-strong|accent|danger|panel|panel-strong|paper|paper-deep|accent-soft|accent-deep|warning|radius|radius-sm)\)\]/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? sources(p) : /\.(tsx?|jsx?)$/.test(name) ? [p] : [];
  });
}

describe.each(TEMPLATES)('%s', (template) => {
  const css = read(template, 'web/src/index.css');
  const theme = css.match(/@theme inline \{([^}]*)\}/)?.[1] ?? '';
  const block = (selector: RegExp) => css.match(selector)?.[0] ?? '';
  const light = block(/:root \{[^}]*\}/);
  const dark = block(/:root\[data-theme='dark'\] \{[^}]*\}/);

  it('maps the tokens with @theme inline (not a copied-value @theme), right after the Tailwind import', () => {
    expect(css).toMatch(/^@import "tailwindcss";\n\n@theme inline \{/);
    expect(css.match(/@theme\b/g)).toHaveLength(1);
    for (const c of MAPPED_COLOURS) expect(theme, c).toContain(`--color-${c}: var(--${c});`);
    expect(theme).toContain('--radius-pas: var(--radius);');
    expect(theme).toContain('--radius-pas-sm: var(--radius-sm);');
    expect(theme).toContain('--shadow-pas: var(--shadow);');
  });

  it('every mapped colour is a token the theme defines, and the colours switch in the dark theme', () => {
    expect(light).not.toBe('');
    expect(dark).not.toBe('');
    for (const c of MAPPED_COLOURS.filter((n) => n !== 'ink-strong')) {
      expect(light, `light --${c}`).toMatch(new RegExp(`^\\s*--${c}:`, 'm'));
      expect(dark, `dark --${c}`).toMatch(new RegExp(`^\\s*--${c}:`, 'm'));
    }
    expect(light).toMatch(/--danger-soft: #fef2f2;/);
    expect(dark).toMatch(/--danger-soft: #450a0a;/);
  });

  it('ships no banned alias', () => {
    expect(css).not.toMatch(/--(bg|surface|border|error|glass|dock)\s*:/);
  });

  it('writes components in the mapped utilities: no [var(--token)] left, and the utilities are used', () => {
    const files = sources(join(ROOT, 'templates', template, 'web/src'));
    expect(files.length).toBeGreaterThan(0);
    const all = files.map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(all.match(new RegExp(BANNED_ARBITRARY.source, 'g')) ?? []).toEqual([]);
    for (const utility of ['text-ink', 'text-muted', 'border-line', 'rounded-pas']) expect(all, utility).toContain(utility);
  });

  it('has a short Styling section in CLAUDE.md that names the layers, the rule and the docs', () => {
    const md = read(template, 'CLAUDE.md');
    const section = md.slice(md.indexOf('## Styling')).split('\n');
    expect(md).toContain('## Styling');
    expect(section.filter((l) => l.trim()).length).toBeLessThanOrEqual(8);
    const text = section.join('\n');
    expect(text).toContain('ADR-011');
    expect(text).toContain('text-ink');
    expect(text).toMatch(/Never add feature classes to `index\.css`/);
    expect(text).toContain('/ui/#styling');
  });
});

it('the three templates carry the same token mapping, so they cannot drift', () => {
  const [first, ...rest] = TEMPLATES.map((t) => read(t, 'web/src/index.css').match(/@theme inline \{[^}]*\}/)![0]);
  for (const other of rest) expect(other).toBe(first);
});

it('the template CSS is not a place for feature classes: only tokens, @theme and @layer base', () => {
  for (const t of TEMPLATES) {
    const css = read(t, 'web/src/index.css');
    expect(css, t).not.toMatch(/^\s*\.(card|btn|input|badge)\b/m);
  }
});
