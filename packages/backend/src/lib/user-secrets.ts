/**
 * Per-user app secrets (#587): a user's own key for one app, in app_user_secrets.
 * Sealed like app secrets (lib/encryption.ts, APP_SECRET_KEK) with associated
 * data binding the ciphertext to its row, so a row copied to another user or
 * app fails to decrypt. Never logged and never returned to a client.
 */
import type { Env } from '../types.js';
import { toUint8 } from './bytes.js';
import { openSecret, sealSecret, type SealedSecret } from './encryption.js';

/** How often last_used_at is rewritten for one secret, to bound D1 writes. */
const LAST_USED_GRANULARITY_MS = 60_000;

/** The associated data of one row. App ids and names cannot contain `|`, so it is unambiguous. */
function userSecretAad(appId: string, userId: string, name: string): string {
  return `${appId}|${userId}|${name}`;
}

export function sealUserSecret(value: string, kek: string, appId: string, userId: string, name: string): Promise<SealedSecret> {
  return sealSecret(value, kek, userSecretAad(appId, userId, name));
}

/**
 * The user's own secret `name` in this app, or null when they have not set it.
 * Throws when the row does not decrypt for (appId, userId, name) — a row moved
 * from another user or app. Marks it used.
 */
export async function openUserSecret(env: Pick<Env, 'DB'>, kek: string, appId: string, userId: string, name: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT key_ciphertext, dek_wrapped, iv FROM app_user_secrets WHERE app_id = ? AND user_id = ? AND name = ?')
    .bind(appId, userId, name).first<{ key_ciphertext: unknown; dek_wrapped: unknown; iv: unknown }>();
  if (!row) return null;
  const plaintext = await openSecret(
    { keyCiphertext: toUint8(row.key_ciphertext), dekWrapped: toUint8(row.dek_wrapped), iv: toUint8(row.iv) },
    kek,
    userSecretAad(appId, userId, name),
  );
  const now = Date.now();
  await env.DB.prepare(
    'UPDATE app_user_secrets SET last_used_at = ?1 WHERE app_id = ?2 AND user_id = ?3 AND name = ?4 AND (last_used_at IS NULL OR last_used_at < ?1 - ?5)',
  ).bind(now, appId, userId, name, LAST_USED_GRANULARITY_MS).run().catch(() => {});
  return plaintext;
}
