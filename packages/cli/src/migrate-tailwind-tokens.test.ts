import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { migrateTailwindTokens } from './migrate-tailwind-tokens.js';

// #494: the codemod rewrites long-hand token utilities and resolves banned aliases by the
// app's own definition. Dry-run by default; idempotent.

const TOKENS = `  --paper: #fafafa;
  --ink: #111;
  --muted: #666;
  --line: #ddd;
  --radius: 8px;
`;
const INDEX = `@import "tailwindcss";
@source "../node_modules/@proappstore/sdk/dist";

:root {
${TOKENS}}
`;

function app(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pas-migrate-'));
  mkdirSync(join(dir, 'web/src'), { recursive: true });
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, 'web/src', f)), { recursive: true });
    writeFileSync(join(dir, 'web/src', f), c);
  }
  return dir;
}
const read = (dir: string, f: string) => readFileSync(join(dir, 'web/src', f), 'utf8');

describe('pas migrate tailwind-tokens (#494)', () => {
  it('rewrites long-hand utilities, keeping variants and opacity, and inserts @theme inline', async () => {
    const dir = app({
      'index.css': INDEX,
      'A.tsx': `export const A = () => <div className="hover:text-[var(--muted)] md:border-[var(--line)]/50 rounded-[var(--radius)] bg-[var(--paper)]" />;`,
    });
    const r = await migrateTailwindTokens({ dir, write: true });
    expect(read(dir, 'A.tsx')).toContain('className="hover:text-muted md:border-line/50 rounded-pas bg-paper"');
    expect(r.themeInserted).toBe(true);
    const css = read(dir, 'index.css');
    expect(css).toMatch(/@source [^\n]+\n\n@theme inline \{\n  --color-paper: var\(--paper\);/);
    expect(css).toContain('--radius-pas: var(--radius);');
    expect(css).not.toContain('--color-danger');
  });

  it('leaves an unknown token unchanged and reports it', async () => {
    const dir = app({ 'index.css': INDEX, 'A.tsx': `const c = "text-[var(--unknown)] text-[var(--ink)]";` });
    const r = await migrateTailwindTokens({ dir, write: true });
    expect(read(dir, 'A.tsx')).toBe(`const c = "text-[var(--unknown)] text-ink";`);
    expect(r.unknownTokens).toEqual({ '--unknown': 1 });
    expect(r.report.join('\n')).toContain('--unknown');
  });

  it('does not touch a bare arbitrary value or CSS-in-JS', async () => {
    const src = `const a = '[var(--ink)]'; const s = { color: 'var(--ink)' }; const t = 'x-text-[var(--ink)]';`;
    const dir = app({ 'index.css': INDEX, 'A.tsx': src });
    await migrateTailwindTokens({ dir, write: true });
    expect(read(dir, 'A.tsx')).toBe(src);
  });

  it("inlines a banned alias by the app's own definition and deletes it", async () => {
    const dir = app({
      'index.css': INDEX.replace('}\n', '  --surface: var(--paper);\n}\n') + '.x { background: var(--surface); }\n',
      'A.tsx': `const c = "bg-[var(--surface)]";`,
    });
    const r = await migrateTailwindTokens({ dir, write: true });
    const css = read(dir, 'index.css');
    expect(css).not.toContain('--surface');
    expect(css).toContain('background: var(--paper);');
    expect(read(dir, 'A.tsx')).toBe(`const c = "bg-paper";`);
    expect(r.inlinedAliases).toEqual([{ alias: '--surface', target: '--paper' }]);
  });

  it('reports and skips an alias that resolves differently in light and dark', async () => {
    const css = INDEX.replace('}\n', '  --surface: var(--paper);\n}\n') + ":root[data-theme='dark'] {\n  --paper: #000;\n  --surface: var(--ink);\n}\n";
    const dir = app({ 'index.css': css, 'A.tsx': `const c = "bg-[var(--surface)]";` });
    const r = await migrateTailwindTokens({ dir, write: true });
    expect(read(dir, 'index.css')).toContain('--surface: var(--paper);');
    expect(read(dir, 'A.tsx')).toBe(`const c = "bg-[var(--surface)]";`);
    expect(r.skippedAliases).toEqual([{ alias: '--surface', reason: 'resolves to --paper in light but --ink in dark' }]);
  });

  it('is a dry run by default and idempotent when written', async () => {
    const files = { 'index.css': INDEX, 'A.tsx': `const c = "text-[var(--muted)]";` };
    const dir = app(files);
    const dry = await migrateTailwindTokens({ dir, write: false });
    expect(dry.replacements).toBeGreaterThan(0);
    expect(dry.changes.find((c) => c.file === 'web/src/A.tsx')!.diff).toContain('+const c = "text-muted";');
    expect(read(dir, 'A.tsx')).toBe(files['A.tsx']);
    expect(read(dir, 'index.css')).toBe(INDEX);
    await migrateTailwindTokens({ dir, write: true });
    const again = await migrateTailwindTokens({ dir, write: true });
    expect(again.changes).toEqual([]);
  });

  it('reports unlayered rules, hex and dark overrides it cannot fix', async () => {
    const css = INDEX + `.card { color: #abc; }\n@layer base { body { margin: 0; } }\n:root[data-theme='dark'] .card { color: red; }\n`;
    const dir = app({ 'index.css': css });
    const r = await migrateTailwindTokens({ dir, write: false });
    const text = r.report.join('\n');
    expect(text).toMatch(/unlayered rule/);
    expect(text).toMatch(/hex value/);
    expect(text).toMatch(/dark override/);
  });

  it('errors without web/src', async () => {
    await expect(migrateTailwindTokens({ dir: mkdtempSync(join(tmpdir(), 'pas-migrate-')), write: false })).rejects.toThrow(/web\/src/);
  });

  // bookkeeper origin/main: 1,690 long-hand uses. Skipped where the sibling clone is absent.
  const clone = join(dirname(fileURLToPath(import.meta.url)), '../../../../apps/bookkeeper');
  const archive = (): string | null => {
    try {
      if (!existsSync(join(clone, '.git'))) return null;
      const dir = mkdtempSync(join(tmpdir(), 'pas-bk-'));
      const tar = execFileSync('git', ['-C', clone, 'archive', 'origin/main', 'web/src'], { maxBuffer: 1 << 28 });
      execFileSync('tar', ['-x', '-C', dir], { input: tar });
      return dir;
    } catch { return null; }
  };
  const bk = archive();
  it.skipIf(!bk)('migrates a copy of bookkeeper web/src: long-hand gone, mapped tokens only, idempotent', async () => {
    const countLong = () => execFileSync('sh', ['-c', `grep -rhoE '[a-z-]+-\\[var\\(--[a-z-]+\\)\\]' web/src | wc -l`], { cwd: bk! }).toString().trim();
    const before = Number(countLong());
    expect(before).toBeGreaterThan(1000);
    const dry = await migrateTailwindTokens({ dir: bk!, write: false });
    expect(dry.replacements).toBeGreaterThan(1000);
    expect(Number(countLong())).toBe(before);
    const r = await migrateTailwindTokens({ dir: bk!, write: true });
    expect(r.themeInserted).toBe(true);
    // What stays is exactly what the #492 mapping has no entry for: four bookkeeper-only
    // tokens, reported; and `accent-[var(--accent)]` (the form-control utility, not a colour prefix).
    expect(Object.keys(r.unknownTokens).sort()).toEqual(['--accent-hover', '--panel-hover', '--success-soft', '--warning-soft']);
    const rest = execFileSync('sh', ['-c', `grep -rhoE '[a-z-]+-\\[var\\(--[a-z-]+\\)\\]' web/src | sed -E 's/-\\[.*//' | sort | uniq -c`], { cwd: bk! }).toString();
    expect(Number(countLong())).toBe(Object.values(r.unknownTokens).reduce((a, b) => a + b, 0) + Number(/(\d+) accent$/m.exec(rest)?.[1] ?? 0));
    expect(r.report.join('\n')).toContain('--panel-hover');
    expect((await migrateTailwindTokens({ dir: bk!, write: true })).changes).toEqual([]);
  });
});
