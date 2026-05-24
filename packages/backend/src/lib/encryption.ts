/**
 * Envelope encryption for app-secret-proxy keys.
 *
 *   plaintext key → AES-256-GCM(DEK) → key_ciphertext
 *   DEK           → AES-256-GCM(KEK) → dek_wrapped
 *
 * Why envelope (vs encrypting every key directly with the master KEK):
 *   - KEK rotation = re-wrap each row's DEK in place. Cheap. Doesn't touch
 *     key_ciphertext.
 *   - Per-row DEK means a leaked DEK only exposes one secret.
 *   - DB compromise alone yields ciphertext. Attacker also needs the KEK
 *     (held only in env.APP_SECRET_KEK as a Worker secret).
 *
 * KEK is base64-encoded 32-byte raw key, stored in env.APP_SECRET_KEK.
 * Set once via:  wrangler secret put APP_SECRET_KEK
 *   (paste output of: openssl rand -base64 32)
 */

export interface SealedSecret {
  /** AES-256-GCM ciphertext of the API key. Includes the auth tag. */
  keyCiphertext: Uint8Array;
  /** DEK encrypted under the KEK (also AES-256-GCM, includes auth tag). */
  dekWrapped: Uint8Array;
  /** 12-byte IV used for the key-ciphertext encryption. */
  iv: Uint8Array;
}

const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 12; // GCM standard
const KEK_IV_LENGTH = 12;

/**
 * Encrypt an API key. Generates a fresh DEK + IV per call; the DEK is
 * then wrapped under the KEK. Returns the three byte sequences to store
 * (key_ciphertext, dek_wrapped, iv).
 */
export async function sealSecret(plaintext: string, kekBase64: string): Promise<SealedSecret> {
  const kek = await importKek(kekBase64);

  // Fresh DEK + IV per row.
  const dekRaw = crypto.getRandomValues(new Uint8Array(KEY_LENGTH));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

  const dek = await crypto.subtle.importKey('raw', dekRaw, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);

  // Encrypt the plaintext key under the DEK.
  const plaintextBytes = new TextEncoder().encode(plaintext);
  const keyCiphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, dek, plaintextBytes),
  );

  // Wrap the DEK under the KEK with its own IV. We store iv_kek prepended
  // to dekWrapped so we don't need a third column.
  const ivKek = crypto.getRandomValues(new Uint8Array(KEK_IV_LENGTH));
  const wrapped = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ivKek }, kek, dekRaw),
  );
  const dekWrapped = new Uint8Array(KEK_IV_LENGTH + wrapped.byteLength);
  dekWrapped.set(ivKek, 0);
  dekWrapped.set(wrapped, KEK_IV_LENGTH);

  return { keyCiphertext, dekWrapped, iv };
}

/**
 * Decrypt a sealed secret. Inverse of sealSecret; needs the same KEK.
 * Throws on bad ciphertext / wrong KEK / tampered tag.
 */
export async function openSecret(sealed: SealedSecret, kekBase64: string): Promise<string> {
  const kek = await importKek(kekBase64);

  // Unwrap DEK: split off the prepended IV, decrypt under KEK.
  const ivKek = sealed.dekWrapped.slice(0, KEK_IV_LENGTH);
  const wrappedBody = sealed.dekWrapped.slice(KEK_IV_LENGTH);
  const dekRaw = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivKek }, kek, wrappedBody),
  );

  const dek = await crypto.subtle.importKey('raw', dekRaw, { name: 'AES-GCM' }, false, ['decrypt']);

  const plaintextBytes = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.iv }, dek, sealed.keyCiphertext),
  );
  return new TextDecoder().decode(plaintextBytes);
}

async function importKek(kekBase64: string): Promise<CryptoKey> {
  const raw = base64ToBytes(kekBase64);
  if (raw.byteLength !== KEY_LENGTH) {
    throw new Error(
      `APP_SECRET_KEK must be ${KEY_LENGTH} bytes base64-encoded (got ${raw.byteLength})`,
    );
  }
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
