import { describe, expect, it } from 'vitest';
import { sealSecret, openSecret, type SealedSecret } from './encryption.js';

// Generate a valid 32-byte KEK (base64-encoded) for tests.
// In production this comes from env.APP_SECRET_KEK.
const TEST_KEK = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

describe('envelope encryption', () => {
  it('round-trips a secret through seal → open', async () => {
    const plaintext = 'sk-test-abc123xyz';
    const sealed = await sealSecret(plaintext, TEST_KEK);
    const recovered = await openSecret(sealed, TEST_KEK);
    expect(recovered).toBe(plaintext);
  });

  it('handles empty string', async () => {
    const sealed = await sealSecret('', TEST_KEK);
    const recovered = await openSecret(sealed, TEST_KEK);
    expect(recovered).toBe('');
  });

  it('handles unicode plaintext', async () => {
    const plaintext = 'key-with-emoji-🔑-and-日本語';
    const sealed = await sealSecret(plaintext, TEST_KEK);
    expect(await openSecret(sealed, TEST_KEK)).toBe(plaintext);
  });

  it('handles long plaintext (4KB API key)', async () => {
    const plaintext = 'x'.repeat(4096);
    const sealed = await sealSecret(plaintext, TEST_KEK);
    expect(await openSecret(sealed, TEST_KEK)).toBe(plaintext);
  });

  it('produces unique ciphertext for each seal (fresh DEK + IV)', async () => {
    const plaintext = 'same-key-sealed-twice';
    const a = await sealSecret(plaintext, TEST_KEK);
    const b = await sealSecret(plaintext, TEST_KEK);

    // Same plaintext but different DEK + IV → different ciphertext
    expect(a.keyCiphertext).not.toEqual(b.keyCiphertext);
    expect(a.iv).not.toEqual(b.iv);
    expect(a.dekWrapped).not.toEqual(b.dekWrapped);

    // Both still decrypt to the same plaintext
    expect(await openSecret(a, TEST_KEK)).toBe(plaintext);
    expect(await openSecret(b, TEST_KEK)).toBe(plaintext);
  });

  it('returns the correct byte array types', async () => {
    const sealed = await sealSecret('test', TEST_KEK);
    expect(sealed.keyCiphertext).toBeInstanceOf(Uint8Array);
    expect(sealed.dekWrapped).toBeInstanceOf(Uint8Array);
    expect(sealed.iv).toBeInstanceOf(Uint8Array);
    expect(sealed.iv.byteLength).toBe(12); // GCM standard IV
  });

  it('fails to decrypt with a wrong KEK', async () => {
    const sealed = await sealSecret('secret', TEST_KEK);
    const wrongKek = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    await expect(openSecret(sealed, wrongKek)).rejects.toThrow();
  });

  it('fails on tampered ciphertext (auth tag integrity)', async () => {
    const sealed = await sealSecret('secret', TEST_KEK);
    // Flip a byte in the ciphertext
    const tampered: SealedSecret = {
      ...sealed,
      keyCiphertext: new Uint8Array([...sealed.keyCiphertext]),
    };
    tampered.keyCiphertext[0] ^= 0xff;
    await expect(openSecret(tampered, TEST_KEK)).rejects.toThrow();
  });

  it('fails on tampered DEK wrapper', async () => {
    const sealed = await sealSecret('secret', TEST_KEK);
    const tampered: SealedSecret = {
      ...sealed,
      dekWrapped: new Uint8Array([...sealed.dekWrapped]),
    };
    tampered.dekWrapped[tampered.dekWrapped.length - 1] ^= 0xff;
    await expect(openSecret(tampered, TEST_KEK)).rejects.toThrow();
  });

  it('rejects a KEK with wrong length', async () => {
    const shortKek = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
    await expect(sealSecret('test', shortKek)).rejects.toThrow(/must be 32 bytes/);
  });
});
