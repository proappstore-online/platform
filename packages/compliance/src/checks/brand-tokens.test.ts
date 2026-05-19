import { describe, expect, it } from 'vitest';
import { mapFileSource } from '../lib/file-source.js';
import { checkBrandTokens } from './brand-tokens.js';

describe('checkBrandTokens', () => {
  it('passes for an app defining --paper, --ink, --accent', async () => {
    const files = new Map([
      [
        'web/src/index.css',
        `:root {
  --paper: #fafaf7;
  --ink: #111;
  --accent: #c84;
}`,
      ],
    ]);
    const r = await checkBrandTokens(mapFileSource(files));
    expect(r.status).toBe('pass');
    expect(r.detail).toMatch(/--paper/);
  });

  it('fails for an app missing one of --paper / --ink / --accent', async () => {
    const files = new Map([['web/src/index.css', ':root { --paper: white; --ink: black; }']]);
    const r = await checkBrandTokens(mapFileSource(files));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/--accent/);
  });

  it('passes for a game defining --bg, --ink, --accent', async () => {
    const files = new Map([
      ['package.json', '{"dependencies":{"@proappstore/games":"^0.1"}}'],
      ['web/src/index.css', ':root { --bg: #000; --ink: #fff; --accent: lime; }'],
    ]);
    const r = await checkBrandTokens(mapFileSource(files));
    expect(r.status).toBe('pass');
  });

  it('fails for a game that defines --paper instead of --bg', async () => {
    const files = new Map([
      ['package.json', '{"dependencies":{"@proappstore/games":"^0.1"}}'],
      ['web/src/index.css', ':root { --paper: white; --ink: #fff; --accent: lime; }'],
    ]);
    const r = await checkBrandTokens(mapFileSource(files));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/--bg/);
  });

  it('does not match var(--paper) usage as a definition', async () => {
    // Using the token (var()) is not the same as defining it.
    const files = new Map([
      [
        'web/src/App.css',
        '.btn { color: var(--paper); background: var(--ink); border: 1px solid var(--accent); }',
      ],
    ]);
    const r = await checkBrandTokens(mapFileSource(files));
    expect(r.status).toBe('fail');
  });
});
