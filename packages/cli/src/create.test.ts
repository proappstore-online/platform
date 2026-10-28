import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const childProcess = vi.hoisted(() => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('node:child_process', () => childProcess);
vi.mock('./og-image.js', () => ({ writeOgImage: vi.fn() }));
vi.mock('./lettermark.js', () => ({ writeDefaultIcons: vi.fn() }));

const { createApp } = await import('./create.js');
const { writeDefaultIcons } = await import('./lettermark.js');

let cwd: string;
let dir: string;

beforeEach(() => {
  cwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), 'pas-create-'));
  process.chdir(dir);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  childProcess.execFile.mockImplementation((_cmd, _args, _options, callback) => {
    callback(null, '0123456789abcdef\n', '');
  });
  childProcess.spawn.mockImplementation((_cmd: string, args: string[]) => {
    const handlers: Record<string, (code: number) => void> = {};
    if (args[0] === 'clone') mkdirSync(args.at(-1)!, { recursive: true });
    queueMicrotask(() => handlers.exit?.(0));
    return {
      on(event: string, handler: (code: number) => void) {
        handlers[event] = handler;
        return this;
      },
    };
  });
});

afterEach(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('pas create provisioning', () => {
  it('uses the app-owned name as the default provisioned description', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      requests.push({ url, init });
      if (url.endsWith('/catalogue.json')) {
        return Response.json({ templates: [{
          id: 'template-app', repo: 'proappstore-online/template-app', ref: 'main', status: 'approved', default: true, deprecation: null,
        }] });
      }
      if (url.endsWith('/v1/provision')) return Response.json({ appId: 'my-app', steps: [] });
      throw new Error(`unexpected fetch ${url}`);
    }));

    await createApp('my-app', { skipInstall: true, skipGit: true, token: 'synthetic-token' });

    const provision = requests.find(({ url }) => url.endsWith('/v1/provision'))!;
    expect(JSON.parse(String(provision.init.body))).toMatchObject({
      appId: 'my-app',
      description: 'My App',
    });
  });

  it('writes the lettermark icons for the new app on `pas create` (#505)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/catalogue.json')) {
        return Response.json({ templates: [{
          id: 'template-app', repo: 'proappstore-online/template-app', ref: 'main', status: 'approved', default: true, deprecation: null,
        }] });
      }
      if (url.endsWith('/v1/provision')) return Response.json({ appId: 'door-drop', steps: [] });
      throw new Error(`unexpected fetch ${url}`);
    }));
    await createApp('door-drop', { skipInstall: true, skipGit: true, token: 'synthetic-token' });
    expect(writeDefaultIcons).toHaveBeenCalledWith(expect.stringContaining('door-drop'), 'Door Drop');
  });

  it('scaffolds worker/ and registers it in the workspace only with --with-worker (#261)', async () => {
    const catalogue = vi.fn(async (url: string) => {
      if (url.endsWith('/catalogue.json')) {
        return Response.json({ templates: [{
          id: 'template-app', repo: 'proappstore-online/template-app', ref: 'main', status: 'approved', default: true, deprecation: null,
        }] });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', catalogue);
    // The cloned template ships a workspace file; the clone mock only creates the directory.
    childProcess.spawn.mockImplementation((_cmd: string, args: string[]) => {
      const handlers: Record<string, (code: number) => void> = {};
      if (args[0] === 'clone') {
        const target = args.at(-1)!;
        mkdirSync(target, { recursive: true });
        writeFileSync(join(target, 'pnpm-workspace.yaml'), 'packages:\n  - web\n');
      }
      queueMicrotask(() => handlers.exit?.(0));
      return { on(event: string, handler: (code: number) => void) { handlers[event] = handler; return this; } };
    });

    await createApp('with-w', { skipInstall: true, skipGit: true, skipProvision: true, withWorker: true });
    expect(existsSync(join(dir, 'with-w', 'worker', 'package.json'))).toBe(true);
    expect(existsSync(join(dir, 'with-w', 'worker', 'tsconfig.json'))).toBe(true);
    expect(existsSync(join(dir, 'with-w', 'worker', 'src', 'index.ts'))).toBe(true);
    expect(readFileSync(join(dir, 'with-w', 'pnpm-workspace.yaml'), 'utf8')).toContain('  - worker\n');

    await createApp('no-w', { skipInstall: true, skipGit: true, skipProvision: true });
    expect(existsSync(join(dir, 'no-w', 'worker'))).toBe(false);
    expect(readFileSync(join(dir, 'no-w', 'pnpm-workspace.yaml'), 'utf8')).not.toContain('worker');
  });

  it('puts the display name in the HTML titles and the id everywhere else (#499)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/catalogue.json')) {
        return Response.json({ templates: [{
          id: 'template-app', repo: 'proappstore-online/template-app', ref: 'main', status: 'approved', default: true, deprecation: null,
        }] });
      }
      throw new Error(`unexpected fetch ${url}`);
    }));
    childProcess.spawn.mockImplementation((_cmd: string, args: string[]) => {
      const handlers: Record<string, (code: number) => void> = {};
      if (args[0] === 'clone') {
        const target = args.at(-1)!;
        mkdirSync(join(target, 'web'), { recursive: true });
        writeFileSync(join(target, 'web', 'index.html'), [
          '<meta property="og:title" content="APPNAME" />',
          '<meta name="twitter:title" content="APPNAME" />',
          '<meta property="og:url" content="https://APPNAME.proappstore.online/" />',
          '<title>APPNAME</title>',
        ].join('\n'));
      }
      queueMicrotask(() => handlers.exit?.(0));
      return { on(event: string, handler: (code: number) => void) { handlers[event] = handler; return this; } };
    });

    await createApp('door-drop', { skipInstall: true, skipGit: true, skipProvision: true });
    const html = readFileSync(join(dir, 'door-drop', 'web', 'index.html'), 'utf8');
    expect(html).toContain('<title>Door Drop</title>');
    expect(html).toContain('<meta property="og:title" content="Door Drop" />');
    expect(html).toContain('<meta name="twitter:title" content="Door Drop" />');
    expect(html).toContain('https://door-drop.proappstore.online/');
    expect(html).not.toContain('APPNAME');
  });
});

describe('withDisplayTitle (#499)', async () => {
  const { withDisplayTitle } = await import('./create.js');

  it('only touches HTML, only the titles, and escapes the name', () => {
    expect(withDisplayTitle('<title>APPNAME</title>', 'A & B <x>', '.html')).toBe('<title>A &amp; B &lt;x&gt;</title>');
    expect(withDisplayTitle('<title> APPNAME </title>', 'Shop', '.HTML')).toBe('<title>Shop</title>');
    expect(withDisplayTitle('<title>APPNAME</title> APPNAME', 'Shop', '.html')).toBe('<title>Shop</title> APPNAME');
    expect(withDisplayTitle('<title>APPNAME</title>', 'Shop', '.ts')).toBe('<title>APPNAME</title>');
    expect(withDisplayTitle('<meta property="og:description" content="APPNAME" />', 'Shop', '.html')).toBe('<meta property="og:description" content="APPNAME" />');
  });
});
