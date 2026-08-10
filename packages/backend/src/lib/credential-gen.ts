/**
 * Kid-friendly credential generation for provisioned accounts (routes/auth.ts).
 *
 * Logins are `animal-animal-animal` triples — memorable, no PII, and the
 * privacy feature for COPPA (a child never types a real name or email). The
 * word list is unambiguous (no homophones, all easy to read aloud). Passwords
 * are two animals + two digits, joined — easy to read off a printed card,
 * still ~13 bits of entropy on top of the secret login, and the login endpoint
 * is rate-limited on top of that.
 *
 * Randomness is crypto.getRandomValues — these are credentials.
 */

const ANIMALS = [
  'ant', 'bat', 'bear', 'bee', 'bird', 'bug', 'cat', 'chick', 'clam', 'colt',
  'cow', 'crab', 'cub', 'deer', 'dog', 'dove', 'duck', 'eel', 'elk', 'finch',
  'fish', 'fly', 'fox', 'frog', 'goat', 'goose', 'hen', 'hog', 'horse', 'jay',
  'koala', 'lamb', 'lion', 'lynx', 'mole', 'moose', 'moth', 'mouse', 'mule', 'newt',
  'otter', 'owl', 'ox', 'panda', 'pig', 'pony', 'pug', 'pup', 'quail', 'rabbit',
  'ram', 'rat', 'robin', 'seal', 'shark', 'sheep', 'skunk', 'sloth', 'snail', 'snake',
  'swan', 'tiger', 'toad', 'trout', 'turtle', 'wasp', 'whale', 'wolf', 'worm', 'yak',
] as const;

/** Uniform pick from `arr` using rejection sampling (no modulo bias). */
function pick<T>(arr: readonly T[]): T {
  const n = arr.length;
  const limit = Math.floor(256 / n) * n; // largest multiple of n that fits a byte
  const buf = new Uint8Array(1);
  let b: number;
  do {
    crypto.getRandomValues(buf);
    b = buf[0]!;
  } while (b >= limit);
  return arr[b % n]!;
}

function digit(): string {
  return String(pick(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']));
}

/** A fresh `animal-animal-animal` login. ~70^3 ≈ 343k combinations. */
export function generateLogin(): string {
  return `${pick(ANIMALS)}-${pick(ANIMALS)}-${pick(ANIMALS)}`;
}

/** A fresh `animalanimalNN` password — readable off a card, decent entropy. */
export function generatePassword(): string {
  return `${pick(ANIMALS)}${pick(ANIMALS)}${digit()}${digit()}`;
}

/** Normalize a login for storage/lookup: trim + lowercase. */
export function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

/** Logins are lowercase letters, digits, and single hyphens between segments. */
export function isValidLogin(login: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(login) && login.length >= 3 && login.length <= 64;
}

/**
 * Normalize an email for storage/lookup: trim + lowercase.
 *
 * Lowercasing the local part is technically lossy — RFC 5321 lets `A@x.com`
 * and `a@x.com` be different mailboxes — but no provider anyone signs in with
 * treats them that way, and the unique index in 0042 is byte-wise, so the
 * alternative is two separately-loginable rows for one human's address.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// Applied to an already-normalized (lowercased) address, so no case classes.
// Deliberately stricter than RFC 5322: no quoted local parts, no bare-hostname
// or IP-literal domains. Those are valid on paper and never appear on an
// address a teacher types into a provisioning form, and every one of them is a
// parsing edge case we would rather not own.
const EMAIL_RE =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

/**
 * True if `email` (normalized) is a plausible address we will store.
 *
 * Bounds are RFC 5321 §4.5.3.1: 64 octets for the local part, 254 for the
 * whole address as it appears in a path.
 */
export function isValidEmail(email: string): boolean {
  if (email.length > 254) return false;
  const at = email.indexOf('@');
  if (at < 1 || at > 64) return false;
  return EMAIL_RE.test(email);
}

/**
 * Which identifier space a sign-in value belongs to.
 *
 * '@' is the discriminator, and it is unambiguous in both directions:
 * `isValidLogin` rejects '@', so no stored username can look like an email,
 * and `isValidEmail` requires one, so no email can be read as a username. That
 * disjointness is what lets the login endpoint take a single field, and what
 * keeps the two rate-limit keyspaces from colliding. If either predicate ever
 * loosens, this routing breaks first — the test asserting disjointness is the
 * guard.
 */
export function looksLikeEmail(identifier: string): boolean {
  return identifier.includes('@');
}
