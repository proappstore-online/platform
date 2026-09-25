/**
 * BYO key resolution — fetches a project owner's decrypted LLM API key from
 * the PAS backend user key vault via the PAS_BACKEND service binding.
 *
 * The key never travels through the browser: the agent-teams Worker calls the
 * internal /v1/keys/resolve/:provider endpoint worker-to-worker, authenticated
 * with INTERNAL_TOKEN + X-Owner-Id. The plaintext is held only for the duration
 * of a single agent run and is never logged or persisted.
 */

import type { Bindings } from './bindings.ts';
import type { RoleConfig, RuntimeKind } from './types.ts';

/** Map a runtime adapter to its key-vault provider id. */
export function runtimeToProvider(runtime: RuntimeKind): string {
  switch (runtime) {
    case 'cf-native':
      return 'anthropic';
    case 'openai-responses':
      return 'openai';
  }
}

/**
 * The vault providers each runtime can be driven with (#3). An adapter speaks
 * one wire protocol, so a role's `keyProvider` is a choice among the keys that
 * protocol accepts — today exactly the runtime's native provider; listed here so
 * a compatible alternative (a proxy, a reseller) is one entry, not a code path.
 */
export const RUNTIME_KEY_PROVIDERS: Record<RuntimeKind, readonly string[]> = {
  'cf-native': ['anthropic'],
  'openai-responses': ['openai'],
};

/** The provider a role's runs resolve their key from: its stored mapping, else the runtime's native one. */
export function providerForRole(rc: Pick<RoleConfig, 'runtime' | 'keyProvider'>): string {
  return rc.keyProvider ?? runtimeToProvider(rc.runtime);
}

/**
 * Resolve the owner's BYO key for a given provider.
 * Returns the decrypted key, or null if the owner hasn't configured one
 * (or the vault is unavailable). Callers should surface a needs-input /
 * configuration prompt when null.
 */
export async function resolveByoKey(
  env: Bindings,
  ownerId: string,
  provider: string,
): Promise<string | null> {
  if (!env.INTERNAL_TOKEN) {
    console.error('[byo-key] INTERNAL_TOKEN not set');
    return null;
  }
  if (!env.PAS_BACKEND) {
    console.error('[byo-key] PAS_BACKEND service binding not available');
    return null;
  }

  try {
    const res = await env.PAS_BACKEND.fetch(
      new Request(`https://api.proappstore.online/v1/keys/resolve/${provider}`, {
        method: 'GET',
        headers: {
          'X-Internal-Token': env.INTERNAL_TOKEN,
          'X-Owner-Id': ownerId,
        },
      }),
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[byo-key] resolve failed: ${res.status} ${text.slice(0, 200)}`);
      return null;
    }
    const data = (await res.json()) as { key?: string | null; error?: string };
    if (data.error) console.error(`[byo-key] resolve returned error: ${data.error}`);
    return data.key ?? null;
  } catch (err) {
    console.error(`[byo-key] resolve threw: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
