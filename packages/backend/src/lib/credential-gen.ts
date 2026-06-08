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
