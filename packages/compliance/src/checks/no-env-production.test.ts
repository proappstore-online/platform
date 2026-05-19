import { describe, expect, it } from 'vitest';
import { mapFileSource } from '../lib/file-source.js';
import { checkNoEnvProduction } from './no-env-production.js';

describe('checkNoEnvProduction', () => {
  it('passes when no .env.production anywhere', async () => {
    const files = new Map([
      ['package.json', '{}'],
      ['.env', 'FOO=bar'],
      ['.env.example', 'FOO='],
    ]);
    const r = await checkNoEnvProduction(mapFileSource(files));
    expect(r.status).toBe('pass');
  });

  it('fails when .env.production at root', async () => {
    const files = new Map([['.env.production', 'API_KEY=secret']]);
    const r = await checkNoEnvProduction(mapFileSource(files));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/\.env\.production/);
  });

  it('fails when .env.production nested under web/', async () => {
    const files = new Map([['web/.env.production', 'KEY=x']]);
    const r = await checkNoEnvProduction(mapFileSource(files));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/web\/\.env\.production/);
  });

  it('does not match .env.production-like names', async () => {
    const files = new Map([
      ['.env.production.local', 'X=1'], // different basename
      ['env.production', 'X=1'], // missing leading dot
    ]);
    const r = await checkNoEnvProduction(mapFileSource(files));
    expect(r.status).toBe('pass');
  });
});
