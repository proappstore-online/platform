/**
 * Public referral codes (#549). A code is a short, unguessable-enough handle for a promoter
 * relationship; the canonical identity is the internal `app_promoters.id`. 8 characters from a
 * 32-symbol alphabet without look-alikes (no 0/O, 1/I): 40 bits, and the alphabet length divides
 * 256 so masking a random byte is unbiased. Uniqueness is enforced by the database, not here.
 */
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const CODE_LENGTH = 8;
const CODE_PATTERN = new RegExp(`^[${ALPHABET}]{${CODE_LENGTH}}$`);

export function generateCode(random: (length: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  return [...random(CODE_LENGTH)].map((byte) => ALPHABET[byte & 31]).join('');
}

/** A code as a person types or pastes it (case, spaces and hyphens are forgiven), or null if it cannot be one. */
export function normalizeCode(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 32) return null;
  const code = input.toUpperCase().replace(/[\s-]/g, '');
  return CODE_PATTERN.test(code) ? code : null;
}
