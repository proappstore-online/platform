import { MAX_USER_SECRETS_PER_APP, SECRET_NAME_RE } from '../../routes/secrets-shared.js';

/** One name the app accepts a per-user secret under (#587), and what to tell the user about it. */
export interface UserSecretDecl { name: string; label: string; description: string }

const MAX_LABEL_CHARS = 80;
const MAX_DESCRIPTION_CHARS = 500;

/**
 * The `user_secrets` section: `[{ name, label, description }]`, the names a
 * signed-in user may store their own secret under for this app. A write to any
 * other name is refused. Absent is an empty list.
 */
export function validateUserSecrets(raw: unknown): { error: string } | { userSecrets: UserSecretDecl[] } {
  if (raw === undefined || raw === null) return { userSecrets: [] };
  if (!Array.isArray(raw) || raw.length > MAX_USER_SECRETS_PER_APP) {
    return { error: `user_secrets must be an array of at most ${MAX_USER_SECRETS_PER_APP} { name, label, description }` };
  }
  const out: UserSecretDecl[] = [];
  for (const [i, entry] of raw.entries()) {
    const at = `user_secrets[${i}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { error: `${at} must be an object` };
    const unknown = Object.keys(entry).find((k) => !['name', 'label', 'description'].includes(k));
    if (unknown) return { error: `${at}: unknown field "${unknown}"` };
    const { name, label, description } = entry as Record<string, unknown>;
    if (typeof name !== 'string' || !SECRET_NAME_RE.test(name)) return { error: `${at}.name must match ${SECRET_NAME_RE.source}` };
    if (out.some((d) => d.name === name)) return { error: `${at}: duplicate name "${name}"` };
    if (typeof label !== 'string' || !label.trim() || label.length > MAX_LABEL_CHARS) return { error: `${at}.label must be a non-empty string of at most ${MAX_LABEL_CHARS} characters` };
    if (typeof description !== 'string' || !description.trim() || description.length > MAX_DESCRIPTION_CHARS) {
      return { error: `${at}.description must be a non-empty string of at most ${MAX_DESCRIPTION_CHARS} characters` };
    }
    out.push({ name, label, description });
  }
  return { userSecrets: out };
}
