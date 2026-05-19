import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fsFileSource } from '../lib/file-source.js';
import { checkUnsafeVh } from './unsafe-vh.js';

async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fas-unsafe-vh-'));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content);
  }
  return dir;
}

describe('checkUnsafeVh', () => {
  it('passes when no 100vh appears anywhere', async () => {
    const dir = await fixture({
      'web/src/index.css': 'body { height: 100svh; }',
      'web/src/App.tsx': 'export default () => <div className="h-screen-not-really" />;',
    });
    const r = await checkUnsafeVh(fsFileSource(dir));
    expect(r.status).toBe('pass');
    expect(r.detail).toMatch(/no 100vh/);
  });

  it('warns on a literal 100vh in CSS', async () => {
    const dir = await fixture({
      'web/src/index.css': '.full { height: 100vh; }',
    });
    const r = await checkUnsafeVh(fsFileSource(dir));
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/1 occurrence/);
    expect(r.suggestions?.join('\n')).toMatch(/web\/src\/index\.css:1.*100vh/);
    expect(r.suggestions?.join('\n')).toMatch(/100svh.*100dvh/);
  });

  it('warns on Tailwind h-screen / min-h-screen / max-h-screen', async () => {
    const dir = await fixture({
      'web/src/App.tsx': `
        export default () => (
          <div className="h-screen">
            <header className="min-h-screen" />
            <main className="max-h-screen" />
          </div>
        );
      `,
    });
    const r = await checkUnsafeVh(fsFileSource(dir));
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/3 occurrences/);
    const suggestionText = r.suggestions?.join('\n') ?? '';
    expect(suggestionText).toMatch(/h-screen/);
    expect(suggestionText).toMatch(/min-h-screen/);
    expect(suggestionText).toMatch(/max-h-screen/);
  });

  it('respects the `allow-100vh` opt-out comment on the same line', async () => {
    const dir = await fixture({
      'web/src/index.css': `
        .hero { height: 100vh; /* allow-100vh — intentional, hero stays constant under URL bar */ }
      `,
    });
    const r = await checkUnsafeVh(fsFileSource(dir));
    expect(r.status).toBe('pass');
  });

  it('still flags a different line even when one line has the opt-out', async () => {
    const dir = await fixture({
      'web/src/index.css': `.a { height: 100vh; /* allow-100vh */ }
.b { height: 100vh; }
`,
    });
    const r = await checkUnsafeVh(fsFileSource(dir));
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/1 occurrence/); // only the un-opt-out line
  });

  it('does not flag the strings "100svh" / "100dvh" (the recommended fixes)', async () => {
    const dir = await fixture({
      'web/src/index.css': `
        .a { height: 100svh; }
        .b { height: 100dvh; }
      `,
    });
    const r = await checkUnsafeVh(fsFileSource(dir));
    expect(r.status).toBe('pass');
  });

  it('does not match identifiers that contain "100vh" as a substring', async () => {
    const dir = await fixture({
      // `var100vh` and `--my100vhvar` aren't actual unit usage; word
      // boundaries must keep us from flagging them.
      'web/src/foo.ts': 'const var100vh = 1; const x = "--my100vhvar";',
    });
    const r = await checkUnsafeVh(fsFileSource(dir));
    expect(r.status).toBe('pass');
  });

  it('caps reported issues at 5 and notes the rest', async () => {
    const lines = Array.from({ length: 8 }, (_, i) => `.x${i} { height: 100vh; }`).join('\n');
    const dir = await fixture({ 'web/src/index.css': lines });
    const r = await checkUnsafeVh(fsFileSource(dir));
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/8 occurrences/);
    // 5 file:line entries + 1 "...and N more" + 1 final "Replace with..." advice = 7
    expect(r.suggestions?.length).toBe(7);
    expect(r.suggestions?.[5]).toMatch(/and 3 more/);
  });

  it('scans CSS, JS, TS, JSX, TSX, HTML — but skips other extensions', async () => {
    const dir = await fixture({
      'web/src/index.css': '.a { height: 100vh; }',
      'web/src/App.jsx': 'const x = "h-screen";', // string with the class — flagged (real Tailwind usage looks identical)
      'docs/notes.md': 'Use 100vh somewhere', // Markdown — should NOT be scanned
      'web/src/foo.scss': '$h: 100vh;',
    });
    const r = await checkUnsafeVh(fsFileSource(dir));
    expect(r.status).toBe('warn');
    // 3 hits: index.css, App.jsx, foo.scss. notes.md ignored.
    expect(r.detail).toMatch(/3 occurrences/);
  });

  // --- comment + string stripping regression guards ---

  it('does NOT flag 100vh inside a // line comment', async () => {
    const dir = await fixture({
      'web/src/note.ts': '// avoid 100vh on iOS Safari\nexport {};',
    });
    const r = await checkUnsafeVh(fsFileSource(dir));
    expect(r.status).toBe('pass');
  });

  it('does NOT flag 100vh inside a /* CSS block comment */', async () => {
    const dir = await fixture({
      'web/src/note.css': "/* DON'T use 100vh — use 100svh */ body { height: 100svh; }",
    });
    const r = await checkUnsafeVh(fsFileSource(dir));
    expect(r.status).toBe('pass');
  });

  it('still flags 100vh inside a JSX string-literal className (real Tailwind usage)', async () => {
    // Trade-off: string contents are preserved so JSX classNames like
    // `className="h-screen"` are caught. A doc-example string with
    // `"100vh"` would also fire; reviewer can opt out per-line.
    const dir = await fixture({
      'web/src/Hero.tsx': 'export default () => <div className="min-h-screen" />;',
    });
    const r = await checkUnsafeVh(fsFileSource(dir));
    expect(r.status).toBe('warn');
  });
});
