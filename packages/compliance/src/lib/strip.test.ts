import { describe, expect, it } from 'vitest';
import {
  stripCommentsAndStrings,
  stripCommentsForExt,
  stripCommentsOnly,
  stripCssComments,
  stripForExt,
  stripHtmlComments,
} from './strip.js';

describe('stripHtmlComments', () => {
  it('blanks <!-- ... --> bodies, preserves positions', () => {
    const r = stripHtmlComments('<a><!-- x --><b>');
    expect(r.length).toBe('<a><!-- x --><b>'.length);
    expect(r).toBe('<a>          <b>');
  });

  it('keeps real tags outside comments intact', () => {
    expect(stripHtmlComments('<link rel="manifest">')).toBe('<link rel="manifest">');
  });

  it('handles unterminated comments by blanking to EOF', () => {
    const r = stripHtmlComments('<a><!-- unterminated');
    expect(r.length).toBe('<a><!-- unterminated'.length);
    expect(r).toBe('<a>                 ');
  });
});

describe('stripCommentsAndStrings', () => {
  it('blanks // line comments', () => {
    expect(stripCommentsAndStrings('x // hello\ny')).toBe('x         \ny');
  });

  it('blanks /* block */ comments', () => {
    expect(stripCommentsAndStrings('a /* hi */ b')).toBe('a          b');
  });

  it('blanks string-literal contents but keeps the quotes', () => {
    expect(stripCommentsAndStrings('const x = "hello"')).toBe('const x = "     "');
  });

  it('handles \\ escapes inside strings', () => {
    // The escape consumes one extra char; closing quote shouldn't be
    // confused by an escaped one.
    const src = 'const x = "a\\"b"';
    const r = stripCommentsAndStrings(src);
    expect(r.length).toBe(src.length);
    expect(r).toBe('const x = "    "');
  });
});

describe('stripCommentsOnly', () => {
  it('blanks comments but PRESERVES string contents', () => {
    expect(stripCommentsOnly('const x = "hello" // comment')).toBe(
      'const x = "hello"           ',
    );
  });

  it('preserves template literal contents', () => {
    expect(stripCommentsOnly('const x = `font-family: foo`')).toBe(
      'const x = `font-family: foo`',
    );
  });
});

describe('stripCssComments', () => {
  it('blanks /* block */ comments only', () => {
    expect(stripCssComments('body { /* comment */ color: red; }')).toBe(
      'body {               color: red; }',
    );
  });

  it('preserves CSS quoted strings (font-family values)', () => {
    expect(stripCssComments('font-family: "Comic Sans";')).toBe('font-family: "Comic Sans";');
  });

  it('does NOT treat // as a comment (plain CSS has no line comments)', () => {
    expect(stripCssComments('// not a comment in css')).toBe('// not a comment in css');
  });
});

describe('stripForExt / stripCommentsForExt', () => {
  it('dispatches HTML, CSS, JSON, and JS by extension', () => {
    // HTML: strips <!-- --> only
    expect(stripForExt('<a><!-- x --><b>', '.html')).toBe('<a>          <b>');
    // CSS: strips /* */ only
    expect(stripForExt('body { /* c */ font: serif }', '.css')).toBe(
      'body {         font: serif }',
    );
    // JSON: untouched (no comments)
    expect(stripForExt('{"a":"b"}', '.json')).toBe('{"a":"b"}');
    // JS-style: strips //, /* */, and strings
    expect(stripForExt('const x = "hi" // c', '.ts')).toBe('const x = "  "     ');
  });

  it('stripCommentsForExt preserves strings on JS files', () => {
    expect(stripCommentsForExt('const x = "@amp/y" // c', '.ts')).toBe(
      'const x = "@amp/y"     ',
    );
  });

  it('falls back to JS-style for unknown extensions', () => {
    expect(stripForExt('const x = "hi" // c', '.weird')).toBe('const x = "  "     ');
  });
});
