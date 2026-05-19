import { describe, expect, it } from 'vitest';
import { mapFileSource } from '../lib/file-source.js';
import { checkDarkMode } from './dark-mode.js';

describe('checkDarkMode', () => {
  it('passes when CSS has @media (prefers-color-scheme: dark)', async () => {
    const files = new Map([
      ['web/src/index.css', '@media (prefers-color-scheme: dark) { :root { --paper: #111; } }'],
    ]);
    const r = await checkDarkMode(mapFileSource(files));
    expect(r.status).toBe('pass');
  });

  it('passes when JSX uses data-theme', async () => {
    const files = new Map([
      ['web/src/App.tsx', 'export default () => <html data-theme="dark"><body /></html>;'],
    ]);
    const r = await checkDarkMode(mapFileSource(files));
    expect(r.status).toBe('pass');
  });

  it('passes when CSS declares color-scheme', async () => {
    const files = new Map([['web/src/main.css', ':root { color-scheme: light dark; }']]);
    const r = await checkDarkMode(mapFileSource(files));
    expect(r.status).toBe('pass');
  });

  it('warns when no signal in web/src/', async () => {
    const files = new Map([['web/src/App.tsx', 'export default () => <div>hi</div>;']]);
    const r = await checkDarkMode(mapFileSource(files));
    expect(r.status).toBe('warn');
  });

  it('does NOT pass when the signal only appears in a // comment', async () => {
    // The check used to false-pass when the only mention was in a doc
    // comment ("// could use prefers-color-scheme here") with no real
    // implementation.
    const files = new Map([
      ['web/src/App.tsx', '// We could use prefers-color-scheme here.\nexport default () => <div/>;'],
    ]);
    const r = await checkDarkMode(mapFileSource(files));
    expect(r.status).toBe('warn');
  });

  it('does NOT pass when the signal only appears in a /* CSS comment */', async () => {
    const files = new Map([
      ['web/src/index.css', '/* TODO: add prefers-color-scheme block later */ body {}'],
    ]);
    const r = await checkDarkMode(mapFileSource(files));
    expect(r.status).toBe('warn');
  });

  it('skips for game projects', async () => {
    const files = new Map([
      ['package.json', '{"dependencies":{"@proappstore/games":"^0.1"}}'],
      ['web/src/App.tsx', 'export default () => <div>hi</div>;'],
    ]);
    const r = await checkDarkMode(mapFileSource(files));
    expect(r.status).toBe('pass');
    expect(r.detail).toMatch(/skipped/);
  });
});
