/** Stable app ownership plus canonical public aliases: aliases are reserved for
 * their existing identity, even when the same person owns both proposed apps. */
interface AppClaimDatabase {
  prepare(sql: string): { bind(...values: unknown[]): { first<T>(): Promise<T | null> } };
}

interface AppClaim {
  creator_id: string | null;
  alias_reserved?: number;
  /** #686: the ID was renamed away and can never be claimed again. */
  retired?: number;
}

export async function appClaim(db: AppClaimDatabase, appId: string, domain = 'proappstore.online'): Promise<AppClaim | null> {
  try {
    return await db.prepare(
    `SELECT NULL AS creator_id, 0 AS alias_reserved, 1 AS retired FROM app_id_retirements WHERE old_id = ?1
     UNION ALL
     SELECT NULL AS creator_id, 1 AS alias_reserved, 0 AS retired FROM app_custom_domains
      WHERE domain = ?1 || '.' || ?2 AND status = 'active' AND canonical = 1 AND app_id <> ?1
     UNION ALL
     SELECT app_claim.*, 0 AS alias_reserved, 0 AS retired FROM (SELECT creator_id FROM apps WHERE id = ?1) app_claim
     LIMIT 1`,
    ).bind(appId, domain).first<AppClaim>();
  } catch (error) {
    // The admin Worker can deploy before deploy-backend applies 0152 (#686), and
    // a schema that old can also predate 0135's canonical column.
    if (!/no such (table: app_id_retirements|column: canonical)/i.test(errorMessage(error))) throw error;
    return claimBeforeRetirements(db, appId, domain);
  }
}

async function claimBeforeRetirements(db: AppClaimDatabase, appId: string, domain: string): Promise<AppClaim | null> {
  try {
    return await db.prepare(
    `SELECT NULL AS creator_id, 1 AS alias_reserved FROM app_custom_domains
      WHERE domain = ?1 || '.' || ?2 AND status = 'active' AND canonical = 1 AND app_id <> ?1
     UNION ALL
     SELECT app_claim.*, 0 AS alias_reserved FROM (SELECT creator_id FROM apps WHERE id = ?1) app_claim
     LIMIT 1`,
    ).bind(appId, domain).first<AppClaim>();
  } catch (error) {
    // Admin and backend deploy independently. Before135 there can be no
    // canonical aliases; retain the previous ownership check in that one case.
    if (!/no such column: canonical/i.test(errorMessage(error))) throw error;
    return db.prepare('SELECT creator_id FROM apps WHERE id = ?').bind(appId).first<{ creator_id: string }>();
  }
}

const errorMessage = (error: unknown) => String((error as Error)?.message ?? error);
