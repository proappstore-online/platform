import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fsFileSource } from '../lib/file-source.js';
import { checkNoBrandOverrides, scanContent } from './no-brand-overrides.js';

async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fas-brand-'));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content);
  }
  return dir;
}

describe('scanContent (unit)', () => {
  it('flags an override of a protected CSS variable', () => {
    const issues = scanContent(
      'web/src/index.css',
      `
      :root { --accent: hotpink; }
    `,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/--accent/);
  });

  it('does NOT flag using the variable via var()', () => {
    const issues = scanContent(
      'web/src/App.tsx',
      `
      <div style={{ color: 'var(--accent)' }} />
    `,
    );
    expect(issues).toEqual([]);
  });

  it('does not flag a non-protected custom variable (apps can have their own)', () => {
    const issues = scanContent(
      'web/src/index.css',
      `
      :root { --my-shadow: 0 0 4px black; }
    `,
    );
    expect(issues).toEqual([]);
  });

  it('reports line numbers', () => {
    const issues = scanContent('web/src/index.css', `\n\n:root { --paper: red; }\n`);
    expect(issues[0]).toMatch(/:3 /);
  });

  it('does not flag any font-family (PAS apps may use their own licensed fonts)', () => {
    // The font rule stays in FAS (store apps must look consistent with each
    // other) but not in PAS: every app is different, so apps may use their
    // own licensed fonts.
    const css = scanContent(
      'web/src/components/Type.css',
      `
      h1 { font-family: "Comic Sans MS", cursive; }
      code { font-family: SFMono-Regular, Consolas, monospace; }
      `,
    );
    expect(css).toEqual([]);
    const tsx = scanContent(
      'web/src/AppStyle.tsx',
      [
        "const m = css.match(/font-family:\\s*'([^']+)'/);",
        'const s = `body { font-family: \'${t.fontBody}\', serif; }`;',
        "<h1 style={{ fontFamily: 'Comic Sans MS' }} />",
        "<p style={{ fontFamily: `${t.fontDisplay}, serif` }} />",
      ].join('\n'),
    );
    expect(tsx).toEqual([]);
  });
});

describe('checkNoBrandOverrides (integration)', () => {
  it('passes when all CSS uses brand tokens', async () => {
    const dir = await fixture({
      'web/src/index.css': `
        :root { --my-extra: 4px; }
        body { font-family: Manrope, system-ui, sans-serif; }
        h1 { font-family: Fraunces, serif; color: var(--accent); }
      `,
    });
    const r = await checkNoBrandOverrides(fsFileSource(dir));
    expect(r.status).toBe('pass');
  });

  it('fails when an app overrides a protected variable in a non-theme CSS file', async () => {
    // web/src/index.css is the canonical theme file (exempt). Per-component
    // CSS like this isn't.
    const dir = await fixture({
      'web/src/components/Branding.css': `:root { --accent: deeppink; }`,
    });
    const r = await checkNoBrandOverrides(fsFileSource(dir));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/override/);
    expect(r.suggestions?.join(' ')).toMatch(/var\(--accent\)/);
  });

  it('does NOT fail when web/src/index.css legitimately defines tokens (template-owned)', async () => {
    const dir = await fixture({
      'web/src/index.css': `:root { --paper: #ffffff; --ink: #1a1a1a; --accent: #2563eb; }`,
    });
    const r = await checkNoBrandOverrides(fsFileSource(dir));
    expect(r.status).toBe('pass');
  });

  it('passes when an app uses its own fonts', async () => {
    const dir = await fixture({
      'web/src/App.tsx': `
        const h1 = <h1 style={{ fontFamily: "Cormorant Garamond, serif" }} />;
      `,
      'web/src/components/Code.css': `code { font-family: SFMono-Regular, "Comic Sans MS"; }`,
    });
    const r = await checkNoBrandOverrides(fsFileSource(dir));
    expect(r.status).toBe('pass');
  });

  // --- comment-stripping regression guards ---

  it('does NOT flag a CSS-variable override inside a // comment', async () => {
    const dir = await fixture({
      'web/src/App.tsx': '// :root { --accent: hotpink; } — used to be here\nexport {};',
    });
    const r = await checkNoBrandOverrides(fsFileSource(dir));
    expect(r.status).toBe('pass');
  });

  it('does NOT flag a CSS-variable override inside a /* CSS comment */', async () => {
    const dir = await fixture({
      'web/src/components/Card.css': '/* :root { --accent: hotpink; } — old palette */ .card {}',
    });
    const r = await checkNoBrandOverrides(fsFileSource(dir));
    expect(r.status).toBe('pass');
  });
});
