import { describe, expect, it, vi, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// #458: `pas whoami` must recognise a session-token login written by `pas
// login` (config.session), not the obsolete config.github field. Mock
// homedir() the same way config.test.ts does, so this never touches the
// real ~/.proappstore/config.json.
const testHome = await mkdtemp(join(tmpdir(), 'pas-cli-whoami-test-'));
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: () => testHome };
});

const { writeConfig } = await import('./lib/config.js');
const { runWhoami } = await import('./whoami.js');

let stdout: string[];

function captureOutput() {
  stdout = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => { stdout.push(String(chunk)); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
}

afterEach(async () => {
  try { await rm(join(testHome, '.proappstore'), { recursive: true, force: true }); } catch {}
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.PAS_SESSION_TOKEN;
});

describe('pas whoami (#458)', () => {
  it('reports the signed-in login for a valid session token', async () => {
    captureOutput();
    await writeConfig({
      apiBase: 'https://api.proappstore.online',
      authApiBase: 'https://api.proappstore.online',
      session: { token: 'sess-tok', obtainedAt: Date.now() },
    });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://api.proappstore.online/v1/auth/me');
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sess-tok');
      return Response.json({ id: 'gh:1', name: 'serge-ivo', login: 'serge-ivo' });
    }));

    await runWhoami();
    expect(stdout.join('')).toBe('@serge-ivo\n');
  });

  it('reports not signed in when there is no session at all', async () => {
    captureOutput();
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('must not call fetch'); }));

    await expect(runWhoami()).rejects.toThrow('exit 1');
    expect(stdout.join('')).toContain('Not signed in');
  });

  it('reports not signed in (not a stale "signed in" claim) when the session token is rejected', async () => {
    captureOutput();
    await writeConfig({
      apiBase: 'https://api.proappstore.online',
      authApiBase: 'https://api.proappstore.online',
      session: { token: 'expired-tok', obtainedAt: 1 },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('invalid or expired session', { status: 401 })));

    await expect(runWhoami()).rejects.toThrow('exit 1');
    expect(stdout.join('')).toContain('session expired or invalid');
  });

  it('never reports a signed-in user from the obsolete config.github field alone', async () => {
    captureOutput();
    await writeConfig({
      apiBase: 'https://api.proappstore.online',
      authApiBase: 'https://api.proappstore.online',
      github: { accessToken: 'legacy', login: 'stale-login', obtainedAt: 1 },
    } as never);
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('must not call fetch'); }));

    await expect(runWhoami()).rejects.toThrow('exit 1');
    expect(stdout.join('')).toContain('Not signed in');
    expect(stdout.join('')).not.toContain('stale-login');
  });

  it('falls back to PAS_SESSION_TOKEN when no config file exists', async () => {
    captureOutput();
    process.env.PAS_SESSION_TOKEN = 'env-tok';
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer env-tok');
      return Response.json({ login: 'env-user' });
    }));

    await runWhoami();
    expect(stdout.join('')).toBe('@env-user\n');
  });
});
