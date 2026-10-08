/**
 * Which `app_roles.user_id` values a session may match (#272).
 *
 * A role row is normally keyed by the holder's PAS user id (`gh:123`,
 * `google:…`, `cred:…`). Older grants were keyed by a **GitHub login** given
 * before that person had ever signed in, so role checks also match the
 * session's `login` — but only a GitHub session's `login` is a verified
 * identifier. A Google session's `login` is the profile name, and a credential
 * account's is the `displayName` its creator typed at sign-up: matching those
 * would let anyone register an account named `gh:123` (or `bob`) and inherit
 * that user's app roles.
 *
 * So the login alias applies to `gh:` sessions only; every other session
 * matches on its id alone.
 */
export interface RoleSubjectUser {
  id: string;
  login?: string | null;
}

/**
 * The second identity a role check may bind beside `user.id`: the GitHub login
 * for a GitHub session, else the id again. Shaped for the
 * `(user_id = ? OR user_id = ?)` clause every role check uses.
 */
export function roleLoginAlias(user: RoleSubjectUser): string {
  return user.id.startsWith('gh:') && user.login ? user.login : user.id;
}

/** `[user.id, alias]` — bind straight after the app id in a `(user_id = ? OR user_id = ?)` clause. */
export function roleSubjects(user: RoleSubjectUser): [string, string] {
  return [user.id, roleLoginAlias(user)];
}

/**
 * The app's role grants keyed by their holder's canonical user id (#347), as a
 * CTE named `role_holders` over `?1` (the app id). Older grants were keyed by a
 * GitHub login given before the person signed in (#272): such a row belongs to
 * the `gh:` user with that login, exactly as role checks match it
 * (roleSubjects above), so one person is listed once with all their roles.
 * A row keyed by an existing user id stays as it is; a login nobody has signed
 * in with yet stays its own entry.
 */
export const ROLE_HOLDERS_CTE = `role_holders AS (
  SELECT COALESCE(
           CASE WHEN EXISTS (SELECT 1 FROM users x WHERE x.id = r.user_id) THEN r.user_id END,
           (SELECT u.id FROM users u WHERE substr(u.id, 1, 3) = 'gh:' AND u.login = r.user_id ORDER BY u.id LIMIT 1),
           r.user_id) AS user_id,
         r.role_name, r.granted_at
    FROM app_roles r WHERE r.app_id = ?1
)`;
