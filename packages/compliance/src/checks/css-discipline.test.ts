import { describe, expect, it } from 'vitest';
import { mapFileSource } from '../lib/file-source.js';
import { checkCssDiscipline, cssFindings, FEATURE_CLASS_BUDGET, RULE_SEVERITY, type CssRule } from './css-discipline.js';

const TW = JSON.stringify({ devDependencies: { tailwindcss: '^4.0.0' } });
const app = (css: string, extra: Record<string, string> = {}) =>
  mapFileSource(new Map([['web/package.json', TW], ['web/src/index.css', css], ...Object.entries(extra)]));
const rules = (css: string): CssRule[] => cssFindings('a.css', css).map((f) => f.rule).sort();

const CONFORMING = `@import "tailwindcss";
@source "../index.html";
:root { --paper: #fafaf7; --ink: #111; --accent: #d86f4d; --panel: #fff; --line: #ddd; }
:root[data-theme='dark'] { --paper: #0a0a0a; --ink: #eee; --accent: #f08a6a; }
@theme inline { --color-paper: var(--paper); --color-ink: var(--ink); --color-accent: var(--accent); }
@layer base { body { background: var(--paper); color: var(--ink); } }
@media print { .sheet { color: #000; background: #fff; } }
`;

describe('css-discipline — #493 acceptance fixtures', () => {
  it('@layer base { body {} } passes, and so does a whole conforming index.css', async () => {
    expect(rules('@layer base { body { margin: 0 } }')).toEqual([]);
    expect(rules(CONFORMING)).toEqual([]);
    expect((await checkCssDiscipline(app(CONFORMING))).status).toBe('pass');
  });

  it('an unlayered `.ledger button {}` warns', () => {
    expect(rules('.ledger button { margin: 0 }')).toContain('unlayered-rule');
  });

  it('@media print { .sheet {} } passes, with its colours', () => {
    expect(rules('@media print { .sheet { color: #000 } }')).toEqual([]);
  });

  it(":root[data-theme='dark'] .ledger {} warns as a per-screen dark override", () => {
    expect(rules(":root[data-theme='dark'] .ledger { color: var(--ink) }")).toContain('per-screen-dark-override');
    expect(rules('html[data-theme="dark"] > main { gap: 0 }')).toContain('per-screen-dark-override');
    expect(rules('@layer base { :root[data-theme=dark] a { color: red } }')).toContain('per-screen-dark-override');
  });

  it('data-attribute variants of :root / html are token blocks (text size, density), not unlayered rules', () => {
    expect(rules(':root[data-text-size="small"] { --text-base: 14px } html[data-density=compact] { --gap: 4px }')).toEqual([]);
    expect(rules('[data-theme="dark"] { --ink: #eee }')).toEqual([]);
    expect(rules('[data-open] .panel { margin: 0 }')).toContain('unlayered-rule');
  });

  it('a plain dark token block is not an override', () => {
    expect(rules(":root[data-theme='dark'] { --ink: #eee }")).toEqual([]);
  });

  it('`--surface: var(--paper)` warns; --surface-soft and var(--surface-soft) pass', () => {
    expect(rules(':root { --surface: var(--paper); }')).toEqual(['banned-alias']);
    expect(rules(':root { --surface-soft: #f6faf6; } @layer base { a { color: var(--surface-soft) } }')).toEqual([]);
  });
});

describe('css-discipline — every rule, passing and failing', () => {
  it('banned-alias: each banned name, defined or used, whole-name only', () => {
    for (const alias of ['--bg', '--surface', '--border', '--glass', '--dock', '--error']) {
      expect(rules(`:root { ${alias}: red } @layer base { a { color: var(${alias}) } }`).filter((r) => r === 'banned-alias')).toHaveLength(2);
    }
    expect(rules(':root { --icon-bg: 1; --border-radius-x: 2; --error-soft: 3; --bg-2: 4 }')).toEqual([]);
  });

  it('unlayered-rule: layered, @theme, token blocks and nested @media-in-@layer pass; top-level @media does not hide a rule', () => {
    expect(rules('@layer components { .a { margin: 0 } }').includes('unlayered-rule')).toBe(false);
    expect(rules('@layer base { @media (min-width: 640px) { body { margin: 0 } } }').includes('unlayered-rule')).toBe(false);
    expect(rules('@media (min-width: 640px) { .wide { margin: 0 } }')).toContain('unlayered-rule');
    expect(rules('@supports (display: grid) { main { gap: 1px } }')).toContain('unlayered-rule');
    expect(rules('a { color: red }')).toContain('unlayered-rule');
  });

  it('hex-outside-tokens: #rgb, #rrggbb, rgb() and rgba() literals; token blocks, @theme and print are exempt', () => {
    for (const lit of ['#fff', '#ffffff', '#ffff', '#ffffffff', 'rgb(0 0 0)', 'rgba(0, 0, 0, .5)']) {
      expect(rules(`@layer base { a { color: ${lit} } }`), lit).toEqual(['hex-outside-tokens']);
    }
    expect(rules(':root { --a: #abc; --b: rgba(0,0,0,.5) } html[data-theme="dark"] { --a: #abcdef } @theme { --color-a: #fff }')).toEqual([]);
    expect(rules('@keyframes spin { to { color: #f00 } }')).toEqual(['hex-outside-tokens']);
  });

  it('does not read an #id fragment, a url(), a string or a comment as a colour', () => {
    expect(rules('@layer base { a { background: url(#grad); fill: url("#abc"); content: "#fff"; } /* #fff */ }')).toEqual([]);
  });

  it('every finding carries the real file:line, comments included', () => {
    const css = '/* header\n   comment */\n:root { --a: red }\n\n.card {\n  color: #fff;\n}\n';
    const f = cssFindings('web/src/index.css', css);
    expect(f.find((x) => x.rule === 'unlayered-rule')).toMatchObject({ file: 'web/src/index.css', line: 5, what: '.card' });
    expect(f.find((x) => x.rule === 'hex-outside-tokens')).toMatchObject({ line: 6 });
  });
});

describe('css-discipline — the check', () => {
  it('feature-classes: a budget of distinct classes, not one warning per class', async () => {
    const within = Array.from({ length: FEATURE_CLASS_BUDGET }, (_, i) => `.c${i} { margin: 0 }`).join('\n');
    const r = await checkCssDiscipline(app(`@layer components {\n${within}\n}`));
    expect(r.status).toBe('pass');
    const over = Array.from({ length: FEATURE_CLASS_BUDGET + 1 }, (_, i) => `.c${i} { margin: 0 }`).join('\n');
    const w = await checkCssDiscipline(app(`@layer components {\n${over}\n}`));
    expect(w.status).toBe('warn');
    expect(w.detail).toMatch(/feature-classes 1 \(web\/src\/index\.css:2 16 classes \(budget 15\)\)/);
  });

  it('a class repeated across rules counts once', async () => {
    const css = `@layer components { ${Array.from({ length: 30 }, () => '.same { margin: 0 }').join(' ')} }`;
    expect((await checkCssDiscipline(app(css))).status).toBe('pass');
  });

  it('ships as warn, names each rule with file:line evidence, and links the styling docs', async () => {
    const r = await checkCssDiscipline(app('.a { color: #fff }\n.b { color: var(--surface) }'));
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/banned-alias 1 \(web\/src\/index\.css:2 --surface\)/);
    expect(r.detail).toMatch(/unlayered-rule 2 \(web\/src\/index\.css:1 \.a, web\/src\/index\.css:2 \.b\)/);
    expect(r.detail).toMatch(/hex-outside-tokens 1 \(web\/src\/index\.css:1 #fff in \.a\)/);
    expect(r.suggestions?.join(' ')).toMatch(/pas migrate tailwind-tokens --write/);
    expect(r.suggestions?.join(' ')).toMatch(/docs\.proappstore\.online\/ui\/#styling/);
  });

  it('scans every stylesheet, including a flat-layout src/ one', async () => {
    const files = mapFileSource(new Map([['package.json', TW], ['src/index.css', '.x { margin: 0 }']]));
    expect((await checkCssDiscipline(files)).detail).toMatch(/src\/index\.css:1 \.x/);
  });

  it("does not read the app's marketing/ Astro site as the app's stylesheet", async () => {
    const files = mapFileSource(new Map([['web/package.json', TW], ['web/src/index.css', CONFORMING], ['marketing/src/styles/global.css', 'body { color: #123456 } .hero { margin: 0 }']]));
    expect((await checkCssDiscipline(files)).status).toBe('pass');
  });

  it('skips an app with no Tailwind dependency, and a game project', async () => {
    const mui = mapFileSource(new Map([['package.json', '{"dependencies":{"@mui/material":"1"}}'], ['src/a.css', '.x { color: #fff } body { background: var(--bg) }']]));
    expect((await checkCssDiscipline(mui)).detail).toMatch(/not on Tailwind/);
    const game = mapFileSource(new Map([['web/package.json', JSON.stringify({ dependencies: { '@proappstore/games': '1' }, devDependencies: { tailwindcss: '4' } })], ['web/src/a.css', '.x { color: #fff }']]));
    const g = await checkCssDiscipline(game);
    expect(g.status).toBe('pass');
    expect(g.detail).toMatch(/game project/);
  });

  it('exits as warn, never fail, in this release; the flip is one table', () => {
    expect(Object.values(RULE_SEVERITY).every((s) => s === 'warn')).toBe(true);
    expect(Object.keys(RULE_SEVERITY).sort()).toEqual(['banned-alias', 'feature-classes', 'hex-outside-tokens', 'per-screen-dark-override', 'unlayered-rule']);
  });
});
