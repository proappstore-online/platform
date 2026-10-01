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
