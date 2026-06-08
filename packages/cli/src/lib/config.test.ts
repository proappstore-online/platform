import { describe, expect, it, vi, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// We need to mock homedir() to point to a temp dir so tests don't
// touch the real ~/.proappstore/config.json.
const testHome = await mkdtemp(join(tmpdir(), 'pas-cli-test-'));
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: () => testHome };
});

const { readConfig, writeConfig, resolveToken } = await import('./config.js');

afterEach(async () => {
  // Clean up config between tests
  try { await rm(join(testHome, '.proappstore'), { recursive: true, force: true }); } catch {}
});

describe('readConfig', () => {
  it('returns defaults when no config file exists', async () => {
    const config = await readConfig();
    expect(config.apiBase).toBe('https://api.proappstore.online');
    expect(config.authApiBase).toBe('https://api.proappstore.online');
    expect(config.session).toBeUndefined();
  });

  it('merges saved config over defaults', async () => {
    await writeConfig({
      apiBase: 'https://custom-api.example.com/',
      authApiBase: 'https://custom-auth.example.com/',
      session: { token: 'tok-123', obtainedAt: 1000 },
    });
    const config = await readConfig();
    // Trailing slash is stripped
    expect(config.apiBase).toBe('https://custom-api.example.com');
    expect(config.session?.token).toBe('tok-123');
  });
});

describe('writeConfig', () => {
  it('creates config dir with restricted permissions', async () => {
    await writeConfig({
      apiBase: 'https://api.proappstore.online',
      authApiBase: 'https://api.proappstore.online',
    });
    const raw = await readFile(join(testHome, '.proappstore', 'config.json'), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.apiBase).toBe('https://api.proappstore.online');
  });

  it('round-trips session data', async () => {
    const config = {
      apiBase: 'https://api.proappstore.online',
      authApiBase: 'https://api.proappstore.online',
      session: { token: 'test-token', obtainedAt: Date.now() },
    };
    await writeConfig(config);
    const loaded = await readConfig();
    expect(loaded.session?.token).toBe('test-token');
  });
});

describe('resolveToken', () => {
  const origEnv = process.env.PAS_SESSION_TOKEN;
  afterEach(() => {
    if (origEnv === undefined) delete process.env.PAS_SESSION_TOKEN;
    else process.env.PAS_SESSION_TOKEN = origEnv;
  });

  it('returns CLI flag token first', () => {
    process.env.PAS_SESSION_TOKEN = 'env-tok';
    expect(resolveToken('cli-tok')).toBe('cli-tok');
  });

  it('falls back to env var', () => {
    process.env.PAS_SESSION_TOKEN = 'env-tok';
    expect(resolveToken()).toBe('env-tok');
  });

  it('falls back to config file', async () => {
    delete process.env.PAS_SESSION_TOKEN;
    await writeConfig({
      apiBase: 'https://api.proappstore.online',
      authApiBase: 'https://api.proappstore.online',
      session: { token: 'file-tok', obtainedAt: 1000 },
    });
    expect(resolveToken()).toBe('file-tok');
  });

  it('returns null when nothing is available', () => {
    delete process.env.PAS_SESSION_TOKEN;
    expect(resolveToken()).toBeNull();
  });
});
