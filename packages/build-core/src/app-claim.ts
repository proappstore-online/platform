/** Stable app ownership plus canonical public aliases: aliases are reserved for
 * their existing identity, even when the same person owns both proposed apps. */
interface AppClaimDatabase {
  prepare(sql: string): { bind(...values: unknown[]): { first<T>(): Promise<T | null> } };
}

export async function appClaim(db: AppClaimDatabase, appId: string, domain = 'proappstore.online'): Promise<{ creator_id: string | null; alias_reserved?: number } | null> {
  try {
    return await db.prepare(
    `SELECT NULL AS creator_id, 1 AS alias_reserved FROM app_custom_domains
      WHERE domain = ?1 || '.' || ?2 AND status = 'active' AND canonical = 1 AND app_id <> ?1
     UNION ALL
     SELECT app_claim.*, 0 AS alias_reserved FROM (SELECT creator_id FROM apps WHERE id = ?1) app_claim
     LIMIT 1`,
    ).bind(appId, domain).first<{ creator_id: string | null; alias_reserved?: number }>();
  } catch (error) {
    // Admin and backend deploy independently. Before135 there can be no
    // canonical aliases; retain the previous ownership check in that one case.
    if (!/no such column: canonical/i.test(String((error as Error)?.message ?? error))) throw error;
    return db.prepare('SELECT creator_id FROM apps WHERE id = ?').bind(appId).first<{ creator_id: string }>();
  }
}
