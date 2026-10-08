/**
 * PAS-SENSITIVE-FIELDS (#294): field names the platform never returns from an
 * app's data through the console operator view — whoever asks, owners and
 * admins included. Categorical, never role-based: the decision is made from
 * the name alone, after the data worker answers and before anything leaves.
 *
 * A name is sensitive when one of its words is a listed term (words are split
 * on `_`, `-`, camelCase and between letters and digits, so `token2` is
 * `token`), when one of its words ends in `secret(s)` or `token(s)`
 * (`clientsecret`, `csrftoken`), when it contains one of the unambiguous
 * compounds (`apikey`, `signingkey`, …) written as one word, or when it starts
 * with the `_internal` prefix. Matching whole words and suffixes keeps
 * `monkey`, `keyboard`, `hashtag`, `secretary` and `tokenizer` out; `key` has
 * no suffix rule because `monkey` and `turkey` end in it, so `…key` secrets are
 * listed as compounds (#335).
 *
 * The list is human-curated and documented in docs/mcp-app-tools.md
 * ("Sensitive fields"). Add to it; never remove from it without a review.
 */

/** Whole words that mark a field as sensitive. */
export const SENSITIVE_FIELD_TERMS = [
  'password', 'passwd', 'passphrase', 'pwd',
  'secret', 'secrets',
  'token', 'tokens', 'jwt', 'bearer', 'cookie', 'cookies',
  'key', 'keys', 'apikey',
  'hash', 'hashed', 'salt',
  'credential', 'credentials',
] as const;

/** Endings that mark a one-word compound (`clientsecret`, `sessiontoken`, `idtokens`) (#335). */
export const SENSITIVE_FIELD_SUFFIXES = ['secret', 'secrets', 'token', 'tokens'] as const;

/** Compounds caught even when written as one word (`apikey`, `authtoken`, `passwordhash`). */
export const SENSITIVE_FIELD_COMPOUNDS = [
  'password', 'passwd', 'passphrase', 'apikey', 'authtoken', 'accesstoken', 'refreshtoken', 'privatekey', 'credential',
  'secretkey', 'signingkey', 'privkey', 'hmackey', 'encryptionkey', 'masterkey', 'sessionkey',
] as const;

/** Fields an app marks as platform-internal by naming convention. */
export const INTERNAL_FIELD_PREFIX = '_internal';

const TERMS = new Set<string>(SENSITIVE_FIELD_TERMS);

/** The words of a field name, lower-cased: `apiKey`, `api_key` and `api_key2` all give `api`, `key` (and `2`). */
function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([a-zA-Z])([0-9])|([0-9])([a-zA-Z])/g, '$1$3_$2$4')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Why `name` is sensitive (the term, compound or prefix it matched), or null when it is not. */
export function sensitiveMatch(name: string): string | null {
  if (name.toLowerCase().startsWith(INTERNAL_FIELD_PREFIX)) return INTERNAL_FIELD_PREFIX;
  const parts = words(name);
  const term = parts.find((w) => TERMS.has(w));
  if (term) return term;
  for (const w of parts) {
    const suffix = SENSITIVE_FIELD_SUFFIXES.find((s) => w.endsWith(s));
    if (suffix) return suffix;
  }
  const squashed = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SENSITIVE_FIELD_COMPOUNDS.find((c) => squashed.includes(c)) ?? null;
}

export function isSensitiveField(name: string): boolean {
  return sensitiveMatch(name) !== null;
}
