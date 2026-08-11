import { describe, expect, it } from 'vitest';
import { type IgnoreLayer, isIgnored, parseGitignore } from './gitignore.js';

/** One root-level .gitignore, the common case. */
function root(text: string): IgnoreLayer[] {
  return [{ base: '', rules: parseGitignore(text) }];
}

const file = (layers: IgnoreLayer[], p: string) => isIgnored(layers, p, false);
const dir = (layers: IgnoreLayer[], p: string) => isIgnored(layers, p, true);

describe('parseGitignore — line handling', () => {
  it('skips blanks and comments', () => {
    expect(parseGitignore('\n# a comment\n\n   \n')).toHaveLength(0);
  });

  it('treats an escaped # or ! as a literal name', () => {
    const layers = root('\\#notes.md\n\\!bang.md');
    expect(file(layers, '#notes.md')).toBe(true);
    expect(file(layers, '!bang.md')).toBe(true);
  });

  it('strips unescaped trailing spaces but keeps escaped ones', () => {
    expect(file(root('build   '), 'build')).toBe(true);
    expect(file(root('odd\\ '), 'odd ')).toBe(true);
  });
});

describe('anchoring', () => {
  it('matches a slashless pattern at any depth', () => {
    const layers = root('report.html');
    expect(file(layers, 'report.html')).toBe(true);
    expect(file(layers, 'deep/nested/report.html')).toBe(true);
  });

  it('anchors a leading-slash pattern to the root only', () => {
    const layers = root('/report.html');
    expect(file(layers, 'report.html')).toBe(true);
    expect(file(layers, 'sub/report.html')).toBe(false);
  });

  it('anchors when a slash appears mid-pattern', () => {
    const layers = root('docs/build.html');
    expect(file(layers, 'docs/build.html')).toBe(true);
    expect(file(layers, 'web/docs/build.html')).toBe(false);
  });

  it('does not match a partial path segment', () => {
    // `cover` must not swallow `coverage`.
    expect(dir(root('cover'), 'coverage')).toBe(false);
  });
});

describe('directory-only patterns', () => {
  it('matches a directory but not a same-named file', () => {
    const layers = root('coverage/');
    expect(dir(layers, 'coverage')).toBe(true);
    expect(file(layers, 'coverage')).toBe(false);
  });

  it('matches at any depth without a leading slash', () => {
    expect(dir(root('.vibe-check/'), 'packages/backend/.vibe-check')).toBe(true);
  });

  it('a plain pattern matches both files and directories', () => {
    const layers = root('build');
    expect(dir(layers, 'build')).toBe(true);
    expect(file(layers, 'build')).toBe(true);
  });
});

describe('wildcards', () => {
  it('* stops at a path separator', () => {
    const layers = root('/logs/*.log');
    expect(file(layers, 'logs/app.log')).toBe(true);
    expect(file(layers, 'logs/nested/app.log')).toBe(false);
  });

  it('? matches exactly one non-separator character', () => {
    const layers = root('file?.txt');
    expect(file(layers, 'file1.txt')).toBe(true);
    expect(file(layers, 'file.txt')).toBe(false);
    expect(file(layers, 'file12.txt')).toBe(false);
  });

  it('leading **/ matches at any depth', () => {
    const layers = root('**/tmp.txt');
    expect(file(layers, 'tmp.txt')).toBe(true);
    expect(file(layers, 'a/b/c/tmp.txt')).toBe(true);
  });

  it('trailing /** matches everything below', () => {
    const layers = root('cache/**');
    expect(file(layers, 'cache/a.txt')).toBe(true);
    expect(file(layers, 'cache/deep/b.txt')).toBe(true);
    expect(file(layers, 'cache')).toBe(false);
  });

  it('a mid-pattern /**/ spans zero or more directories', () => {
    const layers = root('a/**/z.txt');
    expect(file(layers, 'a/z.txt')).toBe(true);
    expect(file(layers, 'a/b/z.txt')).toBe(true);
    expect(file(layers, 'a/b/c/z.txt')).toBe(true);
    expect(file(layers, 'q/a/z.txt')).toBe(false);
  });
});

describe('character classes', () => {
  it('matches a range', () => {
    const layers = root('v[0-9].txt');
    expect(file(layers, 'v1.txt')).toBe(true);
    expect(file(layers, 'vx.txt')).toBe(false);
  });

  it('supports git-style [!…] negation', () => {
    const layers = root('v[!0-9].txt');
    expect(file(layers, 'vx.txt')).toBe(true);
    expect(file(layers, 'v1.txt')).toBe(false);
  });

  it('treats an unterminated [ as a literal', () => {
    expect(file(root('a[b.txt'), 'a[b.txt')).toBe(true);
  });
});

describe('negation — last match wins', () => {
  it('re-includes a file excluded by an earlier rule', () => {
    const layers = root('*.log\n!keep.log');
    expect(file(layers, 'debug.log')).toBe(true);
    expect(file(layers, 'keep.log')).toBe(false);
  });

  it('respects order — a later exclude beats an earlier re-include', () => {
    const layers = root('*.log\n!keep.log\nkeep.log');
    expect(file(layers, 'keep.log')).toBe(true);
  });

  it('leaves a path untouched when only a negation matches', () => {
    expect(file(root('!keep.log'), 'keep.log')).toBe(false);
  });
});

describe('nested .gitignore layers', () => {
  const layers: IgnoreLayer[] = [
    { base: '', rules: parseGitignore('*.log') },
    { base: 'web', rules: parseGitignore('!debug.log') },
  ];

  it('applies the root layer outside the nested subtree', () => {
    expect(file(layers, 'debug.log')).toBe(true);
    expect(file(layers, 'api/debug.log')).toBe(true);
  });

  it('lets a deeper file override a shallower one', () => {
    expect(file(layers, 'web/debug.log')).toBe(false);
  });

  it('resolves nested patterns relative to their own directory', () => {
    const scoped: IgnoreLayer[] = [{ base: 'web', rules: parseGitignore('/out.txt') }];
    expect(file(scoped, 'web/out.txt')).toBe(true);
    expect(file(scoped, 'out.txt')).toBe(false);
    expect(file(scoped, 'web/sub/out.txt')).toBe(false);
  });

  it('ignores a layer governing an unrelated subtree', () => {
    const scoped: IgnoreLayer[] = [{ base: 'web', rules: parseGitignore('everything') }];
    expect(file(scoped, 'api/everything')).toBe(false);
  });
});

describe('the chess-academy case (#122)', () => {
  // The exact shape from the issue: a generated QA report, git-ignored, whose
  // inline CSS redefines --muted/--accent and references Inter.
  const layers = root('node_modules\n.vibe-check/\ncoverage/\nplaywright-report/\n');

  it('ignores the generated report', () => {
    expect(dir(layers, '.vibe-check')).toBe(true);
    expect(file(layers, '.vibe-check/report/actions.html')).toBe(true);
  });

  it('still sees real app source', () => {
    expect(file(layers, 'src/app.css')).toBe(false);
    expect(file(layers, 'index.html')).toBe(false);
  });
});
