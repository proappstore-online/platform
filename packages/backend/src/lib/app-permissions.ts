/**
 * #437: the browser permissions each app will ask for, shown on its storefront
 * listing so the browser's prompt is no surprise. Declared in mcp.json
 * `permissions` (registered with the tools) and detected in the app's source by
 * the deploy pipeline; the listing shows both. Catalogue and detector:
 * @proappstore/compliance lib/permissions.ts.
 */
import { PERMISSION_CATALOGUE, PERMISSION_IDS, type DeclaredPermission } from '@proappstore/compliance';

export interface ListingPermission {
  id: string;
  name: string;
  icon: string;
  /** The creator's one-line reason, or null when it was only detected. */
  reason: string | null;
  /** Declared in mcp.json, found in the source, or both. */
  source: 'declared' | 'detected' | 'both';
}

function parseList<T>(json: string | null | undefined): T[] {
  try {
    const v = json ? JSON.parse(json) : [];
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

/** Declared ∪ detected, in catalogue order; an id outside the catalogue is dropped. */
export function listingPermissions(declaredJson: string | null | undefined, detectedJson: string | null | undefined): ListingPermission[] {
  const declared = new Map(parseList<DeclaredPermission>(declaredJson).filter((p) => p && typeof p.id === 'string').map((p) => [p.id, p]));
  const detected = new Set(parseList<string>(detectedJson).filter((id) => typeof id === 'string'));
  return PERMISSION_CATALOGUE.filter((p) => declared.has(p.id) || detected.has(p.id)).map((p) => {
    const d = declared.get(p.id);
    return {
      id: p.id,
      name: p.name,
      icon: p.icon,
      reason: d?.reason ?? null,
      source: d && detected.has(p.id) ? 'both' : d ? 'declared' : 'detected',
    };
  });
}

/** The ids a listing card shows as its icon row: declared ∪ detected, catalogue order. */
export function listingPermissionIds(declaredJson: string | null | undefined, detectedJson: string | null | undefined): string[] {
  return listingPermissions(declaredJson, detectedJson).map((p) => p.id);
}

/** Replace an app's declared permissions (registration). */
export function declaredPermissionsStatement(db: D1Database, appId: string, declared: DeclaredPermission[], now: number): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO app_permissions (app_id, declared_json, declared_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(app_id) DO UPDATE SET declared_json = excluded.declared_json, declared_at = excluded.declared_at`,
  ).bind(appId, JSON.stringify(declared), now);
}

/** Validate a deploy's detected list: known ids only, de-duplicated, catalogue order. */
export function validateDetected(raw: unknown): { error: string } | { detected: string[] } {
  if (!Array.isArray(raw) || raw.length > PERMISSION_IDS.length * 2 || !raw.every((id) => typeof id === 'string')) {
    return { error: 'permissions must be an array of permission ids' };
  }
  const unknown = (raw as string[]).filter((id) => !PERMISSION_IDS.includes(id));
  if (unknown.length) return { error: `unknown permission id(s): ${unknown.slice(0, 5).join(', ')}` };
  return { detected: PERMISSION_IDS.filter((id) => (raw as string[]).includes(id)) };
}
