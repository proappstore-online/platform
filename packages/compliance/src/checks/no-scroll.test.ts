import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fsFileSource } from '../lib/file-source.js';
import { checkNoScroll } from './no-scroll.js';

async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fas-noscroll-'));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content);
  }
  return dir;
}

const GAME_DEPS = JSON.stringify({
  name: 'my-game',
  dependencies: { '@proappstore/games': '^0.1.0' },
});

describe('checkNoScroll', () => {
  it('passes (skipped) when the project is not a game', async () => {
    const dir = await fixture({
      'package.json': JSON.stringify({ name: 'my-app' }),
      'web/src/index.css': 'body { overflow: scroll; }',
    });
    const r = await checkNoScroll(fsFileSource(dir));
    expect(r.status).toBe('pass');
    expect(r.detail).toMatch(/not a game/);
  });

  it('detects @proappstore/games dep as the game signal', async () => {
    const dir = await fixture({
      'package.json': GAME_DEPS,
      'web/src/index.css': 'body { height: 100svh; }',
      'web/src/App.tsx': 'import { GameShell } from "@proappstore/games";',
    });
    const r = await checkNoScroll(fsFileSource(dir));
    // Should at least run the check, not skip.
    expect(r.detail).not.toMatch(/not a game/);
  });

  it('fails when html/body declares overflow: scroll', async () => {
    const dir = await fixture({
      'package.json': GAME_DEPS,
      'web/src/index.css': 'html { overflow: scroll; }',
    });
    const r = await checkNoScroll(fsFileSource(dir));
    expect(r.status).toBe('fail');
    expect(r.suggestions?.join(' ')).toMatch(/GameShell/);
  });

  it('fails when html/body declares overflow: auto', async () => {
    const dir = await fixture({
      'package.json': GAME_DEPS,
      'web/src/index.css': 'body { overflow: auto; }',
    });
    const r = await checkNoScroll(fsFileSource(dir));
    expect(r.status).toBe('fail');
  });

  it('fails on overflow-y: scroll on body', async () => {
    const dir = await fixture({
      'package.json': GAME_DEPS,
      'web/src/index.css': 'body { overflow-y: scroll; padding: 0; }',
    });
    const r = await checkNoScroll(fsFileSource(dir));
    expect(r.status).toBe('fail');
  });

  it('fails on min-height: 100vh on body (creates page taller than viewport)', async () => {
    const dir = await fixture({
      'package.json': GAME_DEPS,
      'web/src/index.css': 'body { min-height: 100vh; }',
    });
    const r = await checkNoScroll(fsFileSource(dir));
    expect(r.status).toBe('fail');
    expect(r.suggestions?.join(' ')).toMatch(/100svh/);
  });

  it('warns when there is no viewport-lock evidence', async () => {
    const dir = await fixture({
      'package.json': GAME_DEPS,
      'web/src/index.css': 'body { padding: 0; }',
      'web/src/App.tsx': 'export default function App() { return <div>game</div>; }',
    });
    const r = await checkNoScroll(fsFileSource(dir));
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/viewport lock/);
  });

  it('passes when GameShell is imported (the canonical viewport lock)', async () => {
    const dir = await fixture({
      'package.json': GAME_DEPS,
      'web/src/App.tsx': `
        import { GameShell, GameTopbar } from "@proappstore/games";
        export default function App() {
          return <GameShell topbar={<GameTopbar score={0} />}>game</GameShell>;
        }
      `,
    });
    const r = await checkNoScroll(fsFileSource(dir));
    expect(r.status).toBe('pass');
  });

  it('passes when CSS has explicit 100svh height lock', async () => {
    const dir = await fixture({
      'package.json': GAME_DEPS,
      'web/src/index.css': '.game-root { height: 100svh; overflow: hidden; }',
    });
    const r = await checkNoScroll(fsFileSource(dir));
    expect(r.status).toBe('pass');
  });
});
