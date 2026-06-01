import { describe, expect, it, vi } from 'vitest';
import { resolveByoKey, runtimeToProvider } from './byo-key.ts';
import type { Bindings } from './index.ts';

describe('runtimeToProvider', () => {
  it('maps cf-native to anthropic', () => {
    expect(runtimeToProvider('cf-native')).toBe('anthropic');
  });
  it('maps openai-responses to openai', () => {
    expect(runtimeToProvider('openai-responses')).toBe('openai');
  });
});

function makeEnv(fetchImpl: (req: Request) => Promise<Response>, internalToken?: string): Bindings {
  return {
    PAS_BACKEND: { fetch: fetchImpl } as unknown as Fetcher,
    INTERNAL_TOKEN: internalToken,
  } as unknown as Bindings;
}

describe('resolveByoKey', () => {
  it('returns null when INTERNAL_TOKEN is unset (never calls backend)', async () => {
    const fetchImpl = vi.fn();
    const env = makeEnv(fetchImpl as never);
    expect(await resolveByoKey(env, 'owner-1', 'anthropic')).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends internal-token + owner-id headers and returns the key', async () => {
    let seen: Request | null = null;
    const env = makeEnv(async (req) => {
      seen = req;
      return new Response(JSON.stringify({ key: 'sk-ant-xyz' }), { status: 200 });
    }, 'secret-123');

    const key = await resolveByoKey(env, 'owner-42', 'anthropic');
    expect(key).toBe('sk-ant-xyz');
    expect(seen!.headers.get('X-Internal-Token')).toBe('secret-123');
    expect(seen!.headers.get('X-Owner-Id')).toBe('owner-42');
    expect(seen!.url).toContain('/v1/keys/resolve/anthropic');
  });

  it('returns null when the vault has no key for the owner', async () => {
    const env = makeEnv(
      async () => new Response(JSON.stringify({ key: null }), { status: 200 }),
      'secret-123',
    );
    expect(await resolveByoKey(env, 'owner-1', 'openai')).toBeNull();
  });

  it('returns null on a non-OK backend response', async () => {
    const env = makeEnv(async () => new Response('nope', { status: 503 }), 'secret-123');
    expect(await resolveByoKey(env, 'owner-1', 'anthropic')).toBeNull();
  });

  it('returns null (does not throw) when the binding throws', async () => {
    const env = makeEnv(async () => {
      throw new Error('network');
    }, 'secret-123');
    expect(await resolveByoKey(env, 'owner-1', 'anthropic')).toBeNull();
  });
});
