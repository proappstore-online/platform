import { describe, expect, it } from 'vitest';
import { mapFileSource } from '../lib/file-source.js';
import { checkCssDiscipline, cssFindings, RULE_SEVERITY } from './css-discipline.js';

const TW = JSON.stringify({ devDependencies: { tailwindcss: '^4.0.0' } });
const app = (css: string, extra: Record<string, string> = {}) =>
  mapFileSource(new Map([['web/package.json', TW], ['web/src/index.css', css], ...Object.entries(extra)]));

const CONFORMING = `@import "tailwindcss";
@source "../index.html";
:root { --paper: #fafaf7; --ink: #111; --accent: #d86f4d; --panel: #fff; --line: #ddd; }
:root[data-theme='dark'] { --paper: #0a0a0a; --ink: #eee; --accent: #f08a6a; }
@theme { --color-paper: var(--paper); --color-ink: var(--ink); --color-accent: var(--accent); }
@layer base { body { background: var(--paper); color: var(--ink); } }
@media print { .sheet { color: #000; background: #fff; } }
`;

describe('css-discipline (ADR-011)', () => {
  it('passes a conforming index.css: tokens, @theme, @layer base, a print sheet', async () => {
    const r = await checkCssDiscipline(app(CONFORMING));
    expect(r.status).toBe('pass');
    expect(cssFindings('x.css', CONFORMING)).toEqual([]);
  });

  it('is outside the rule for an app that does not depend on Tailwind', async () => {
    const files = mapFileSource(new Map([['package.json', '{"dependencies":{"@mui/material":"1"}}'], ['src/a.css', '.x { color: #fff } body { background: var(--bg) }']]));
    const r = await checkCssDiscipline(files);
    expect(r.status).toBe('pass');
    expect(r.detail).toMatch(/outside the ADR-011 rule/);
  });

  it('flags a banned alias, as a declaration or a var(), but not a compound name', () => {
    const f = cssFindings('a.css', ':root { --bg: #000; } @layer base { a { color: var(--border); border-color: var(--icon-bg); margin: var(--surface-gap) } }');
    expect(f.filter((x) => x.rule === 'banned-alias').map((x) => x.what)).toEqual(['--bg', '--border']);
  });

  it('flags an unlayered rule, and its class, and its hex', () => {
    const f = cssFindings('a.css', '.card { background: #fff; padding: 1rem }');
    expect(f.map((x) => x.rule).sort()).toEqual(['feature-classes', 'hex-outside-tokens', 'unlayered-rule']);
  });

  it('a rule inside @layer components is not unlayered, but its class is a feature class and its hex is outside tokens', () => {
    const f = cssFindings('a.css', '@layer components { .btn { color: #123456 } }');
    expect(f.map((x) => x.rule).sort()).toEqual(['feature-classes', 'hex-outside-tokens']);
  });

  it('keeps hex in the token blocks, @theme and @media print; flags it elsewhere, including keyframes', () => {
    expect(cssFindings('a.css', ':root { --a: #abc } html[data-theme="dark"] { --a: #abcdef } @theme { --color-a: #fff }')).toEqual([]);
    const f = cssFindings('a.css', '@keyframes spin { to { color: #f00 } } @layer base { h1 { color: #00ff0080 } }');
    expect(f.filter((x) => x.rule === 'hex-outside-tokens')).toHaveLength(2);
  });

  it('does not read an #id fragment, a url() or a comment as a colour', () => {
    expect(cssFindings('a.css', '@layer base { a { background: url(#grad); fill: url("#abc"); } /* #fff */ }')).toEqual([]);
  });

  it('descends into @media and @supports other than print', () => {
    const f = cssFindings('a.css', '@media (min-width: 640px) { .wide { color: #fff } } @supports (display: grid) { main { gap: 1px } }');
    expect(f.filter((x) => x.rule === 'unlayered-rule').map((x) => x.what)).toEqual(['.wide', 'main']);
  });

  it('ships as warn, names each rule with counts and examples, and suggests the codemod', async () => {
    const r = await checkCssDiscipline(app('.a { color: #fff } .b { color: var(--surface) }'));
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/banned-alias 1 \(--surface\)/);
    expect(r.detail).toMatch(/unlayered-rule 2/);
    expect(r.detail).toMatch(/hex-outside-tokens 1/);
    expect(r.suggestions?.join(' ')).toMatch(/pas migrate tailwind-tokens --write/);
  });

  it('the rule severities are the one place the warn→fail flip happens', () => {
    expect(Object.keys(RULE_SEVERITY).sort()).toEqual(['banned-alias', 'feature-classes', 'hex-outside-tokens', 'unlayered-rule']);
  });
});
