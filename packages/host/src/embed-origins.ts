/**
 * Opt-in embedding (#453). An app that declares `embed: { allow: [...] }` in its mcp.json has
 * those https origins appended to its CSP `frame-ancestors`, for that app only; every other
 * app keeps the default (itself plus PAS's own surfaces). The list is validated at registration
 * (backend lib/manifest/embed.ts); this module is the host's second, independent check, because
 * what it returns is written into a response header.
 */

/** Strict and closed: https, an optional single leading `*.`, ≥2 ASCII labels, an optional port. Nothing a header could be broken with. */
const ORIGIN_RE = /^https:\/\/(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?::\d{1,5})?$/;
export const MAX_EMBED_ORIGINS = 10;

/** Keep only well-formed, distinct origins, at most {@link MAX_EMBED_ORIGINS}. Anything else is dropped, never repaired. */
export function sanitiseEmbedOrigins(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || item.length > 253 || !ORIGIN_RE.test(item) || out.includes(item)) continue;
    out.push(item);
    if (out.length === MAX_EMBED_ORIGINS) break;
  }
  return out;
}

/**
 * The origins allowed to frame `appId`, or [] (the default) when it declares none. Never throws:
 * a missing table (migration not applied yet), an unreadable row or a database error all mean
 * "no extra origins" — the closed default — rather than a failed page.
 */
export async function getEmbedOrigins(db: D1Database, appId: string): Promise<string[]> {
  try {
    const row = await db.prepare("SELECT origins FROM app_embed WHERE app_id = ?1").bind(appId).first<{ origins: string }>();
    if (!row || typeof row.origins !== "string") return [];
    return sanitiseEmbedOrigins(JSON.parse(row.origins));
  } catch (e) {
    if (!/no such table/i.test(String((e as Error)?.message ?? e))) console.error(`[embed] could not read the embed list for ${appId}: ${(e as Error)?.message ?? e}`);
    return [];
  }
}
