/**
 * Password policy for self-registered (adult) credential accounts (#118).
 *
 * `credentials/provision` keeps its 6-character minimum: those are low-value,
 * no-PII child accounts an adult hands out. A self-registered account is an
 * adult's own, so it gets a 12-character minimum and a denylist of the
 * passwords every breach corpus leads with.
 *
 * KDF decision (#118): the hash stays PBKDF2-SHA256 at 100 000 iterations
 * (lib/password.ts). The Workers runtime caps `deriveBits` at 100k, so a real
 * cost increase means a different KDF (scrypt/Argon2 in WASM) — a separate
 * change. The hash format is self-describing, so rows can migrate when that
 * lands. The length floor and the denylist are the compensating controls.
 */
export const SELF_REGISTRATION_MIN_PASSWORD = 12;
export const MAX_PASSWORD_LENGTH = 256;

// The heads of the usual breach-frequency lists, lowercased. Compared after
// lowercasing and stripping non-alphanumerics, so "P@ssword123!" is caught too.
export const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  '123456', '123456789', '12345678', '1234567890', '12345', '1234567', '123123', '111111', '000000', '654321',
  'password', 'password1', 'password123', 'passw0rd', 'pass1234', 'qwerty', 'qwerty123', 'qwertyuiop', 'abc123', 'abcdef',
  'letmein', 'welcome', 'welcome1', 'admin', 'admin123', 'administrator', 'login', 'monkey', 'dragon', 'master',
  'iloveyou', 'sunshine', 'princess', 'football', 'baseball', 'soccer', 'superman', 'batman', 'trustno1', 'shadow',
  'michael', 'jennifer', 'charlie', 'daniel', 'ashley', 'jessica', 'nicole', 'hunter', 'thomas', 'robert',
  'starwars', 'pokemon', 'freedom', 'whatever', 'computer', 'internet', 'secret', 'changeme', 'default', 'guest',
  'hello123', 'hello', 'zaq12wsx', '1q2w3e4r', '1qaz2wsx', 'asdfgh', 'asdfghjkl', 'zxcvbnm', 'qazwsx', 'a1b2c3',
  'aa123456', '11111111', '00000000', '87654321', '112233', '121212', '123321', '666666', '696969', '7777777',
  'proappstore', 'proappstore1', 'proappstore123', 'appstore', 'password12', 'password1234', 'passwordpassword', 'qwerty12345', 'qwertyqwerty', 'letmein123',
  'welcome123', 'iloveyou1', 'sunshine1', 'princess1', 'football1', 'baseball1', 'superman1', 'batman1', 'dragon1', 'master1',
]);

const canonical = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Returns a message for the caller when the password is not acceptable, else null.
 * Never echoes the password.
 */
export function checkSelfRegistrationPassword(password: string, email: string): string | null {
  if (typeof password !== 'string') return 'password is required';
  if (password.length < SELF_REGISTRATION_MIN_PASSWORD) return `password must be at least ${SELF_REGISTRATION_MIN_PASSWORD} characters`;
  if (password.length > MAX_PASSWORD_LENGTH) return `password must be at most ${MAX_PASSWORD_LENGTH} characters`;
  const c = canonical(password);
  // Exact, and with the usual digit padding stripped ("qwerty123456", "2024password").
  const candidates = [c, password.toLowerCase(), c.replace(/\d+$/, ''), c.replace(/^\d+/, '')];
  if (candidates.some((x) => x.length >= 4 && COMMON_PASSWORDS.has(x))) return 'that password is too common — pick something less guessable';
  if (/^\d+$/.test(c)) return 'password must not be digits only';
  if (/^(.)\1+$/.test(password)) return 'password must not be one repeated character';
  const local = canonical(email.split('@')[0] ?? '');
  if (local.length >= 4 && c === local) return 'password must not be your email address';
  return null;
}
