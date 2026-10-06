/**
 * Read one app secret (app_secrets, sealed under APP_SECRET_KEK) on the server:
 * for an app worker's `PAS.secrets.get` (#254) and an inbound hook's verifier
 * (#256). Null when the app has no such secret. Never logged.
 */
import type { Env } from '../types.js';
import { toUint8 } from './bytes.js';
import { openSecret } from './encryption.js';

export async function openAppSecret(env: Pick<Env, 'DB'>, kek: string, appId: string, name: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT key_ciphertext, dek_wrapped, iv FROM app_secrets WHERE app_id = ? AND name = ?')
    .bind(appId, name).first<{ key_ciphertext: unknown; dek_wrapped: unknown; iv: unknown }>();
  if (!row) return null;
  const plaintext = await openSecret({ keyCiphertext: toUint8(row.key_ciphertext), dekWrapped: toUint8(row.dek_wrapped), iv: toUint8(row.iv) }, kek);
  // As the secrets proxy does (routes/secrets-proxy.ts): 1 in 10, to save writes.
  if (Math.random() < 0.1) {
    await env.DB.prepare('UPDATE app_secrets SET last_used_at = ? WHERE app_id = ? AND name = ?').bind(Date.now(), appId, name).run().catch(() => {});
  }
  return plaintext;
}
