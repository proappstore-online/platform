/**
 * Facts about the caller that the platform reads from the account record, never from the request (#513).
 *
 * `is_child` is set at provisioning (a child account has no email and no real name, see docs/auth-session-model.md) and 0 for every
 * adult, credential or OAuth. A missing row is not a child: the only accounts without one are system identities, which are not people.
 * A database failure throws rather than answering 0, so an action that guards on the flag fails closed instead of treating an
 * unreadable account as an adult.
 */
export async function isChildAccount(db: D1Database, userId: string): Promise<boolean> {
  const row = await db.prepare('SELECT COALESCE(is_child, 0) AS child FROM users WHERE id = ?').bind(userId).first<{ child: number }>();
  return row?.child === 1;
}
