import { selectsColumn, type ToolManifest } from '../action-sql.js';

/** The non-tool parts of an app's mcp.json that register with it (#210). */
export interface SiteManifest {
  page_meta?: unknown;
  sitemap?: unknown;
  operator?: unknown;
  /** The console operator-view contract (#240): lib/operator-contract.ts. */
  operator_view?: unknown;
  /** Private apps (#259): `{ mode: 'public' | 'private', roles?: string[] }` — lib/visibility.ts. */
  visibility?: unknown;
  /** The app worker's manifest (#254, #255): `{ secrets?: string[], schedules?: [...] }`. */
  worker?: unknown;
  /** Inbound webhooks (#256): `[{ name, verify, to }]` — lib/hook-verifiers.ts, routes/hooks.ts. */
  hooks?: unknown;
  /** The GitHub connector (#258): `[{ name, kind, modes, pat_secret?, events, hook? }]` — routes/connectors.ts. */
  connectors?: unknown;
  /** Room authorization (#351): `[{ pattern: "chat:*", authorize }]` — lib/room-access.ts. */
  rooms?: unknown;
  /** Reviewed open unscoped actions (#426): `[{ action, reviewer, date, reason }]` — compliance lib/unscoped-policy.ts. */
  approved_unscoped?: unknown;
  /** Browser permissions the app asks for (#437): `[{ id, reason? }]` — compliance lib/permissions.ts. */
  permissions?: unknown;
  /** Opt-in embedding (#453): `{ allow: ["https://example.com"] }` — lib/manifest/embed.ts. */
  embed?: unknown;
  /** Opt-in cross-origin isolation (#452): `"cross-origin"` or `"cross-origin-strict"` — lib/manifest/isolation.ts. */
  isolation?: unknown;
  /** Products the app sells (#507): `{ authorize_action, products: [...] }` — compliance lib/billing-policy.ts. */
  billing?: unknown;
}

/** The site-manifest fields of a submitted mcp.json body, for every registration path. */
export function siteManifestFrom(body: SiteManifest | null | undefined): SiteManifest {
  return { page_meta: body?.page_meta, sitemap: body?.sitemap, operator: body?.operator, operator_view: body?.operator_view, visibility: body?.visibility, worker: body?.worker, hooks: body?.hooks, connectors: body?.connectors, rooms: body?.rooms, approved_unscoped: body?.approved_unscoped, permissions: body?.permissions, embed: body?.embed, isolation: body?.isolation, billing: body?.billing };
}

export interface PageMetaRoute { path: string; action: string; param: string; not_found?: 404 }

const MAX_PAGE_META_ROUTES = 20;
const PATH_LITERAL = /^[A-Za-z0-9._~-]+$/;
const PATH_PARAM = /^:([a-z_][a-z0-9_]*)$/;

/** A public query action in this manifest, or why the reference is refused. */
function publicQueryAction(tools: ToolManifest[], action: unknown, where: string): ToolManifest | string {
  if (typeof action !== 'string' || !action) return `${where}: action is required`;
  const tool = tools.find((t) => t.name === action);
  if (!tool) return `${where}: action "${action}" is not a tool in this manifest`;
  if (tool.requires_auth !== false || tool.operation !== 'query') {
    return `${where}: action "${action}" must be a public query (requires_auth false) — link previews and crawlers are signed out`;
  }
  return tool;
}

/** Validate `page_meta` and `sitemap` against the (already validated) tools. */
export function validateSiteManifest(
  tools: ToolManifest[],
  site: SiteManifest,
): { error: string } | { routes: PageMetaRoute[]; sitemap: string | null } {
  const routes: PageMetaRoute[] = [];
  const pageMeta = site.page_meta ?? [];
  if (!Array.isArray(pageMeta)) return { error: 'page_meta must be an array' };
  if (pageMeta.length > MAX_PAGE_META_ROUTES) return { error: `page_meta: max ${MAX_PAGE_META_ROUTES} routes` };
  const seen = new Set<string>();
  for (const [i, raw] of pageMeta.entries()) {
    const where = `page_meta[${i}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: `${where} must be an object` };
    const { path, action, param, not_found } = raw as Record<string, unknown>;
    if (not_found !== undefined && not_found !== 404) return { error: `${where}: not_found must be 404 when supplied` };
    if (typeof path !== 'string' || path.length > 200 || !path.startsWith('/')) return { error: `${where}: path must start with / (max 200 chars)` };
    if (typeof param !== 'string' || !param) return { error: `${where}: param is required` };
    const segments = path.split('/').slice(1);
    const placeholders = segments.map((seg) => PATH_PARAM.exec(seg)?.[1]).filter((name): name is string => Boolean(name));
    if (segments.some((seg) => !PATH_LITERAL.test(seg) && !PATH_PARAM.test(seg))) {
      return { error: `${where}: path segments are literals ([A-Za-z0-9._~-]) or one :placeholder` };
    }
    if (placeholders.length !== 1 || placeholders[0] !== param) return { error: `${where}: path must contain exactly one placeholder, :${param}` };
    if (seen.has(path)) return { error: `${where}: duplicate path ${path}` };
    seen.add(path);
    const tool = publicQueryAction(tools, action, where);
    if (typeof tool === 'string') return { error: tool };
    if (!tool.params?.[param]) return { error: `${where}: action "${tool.name}" does not declare param "${param}"` };
    const missing = ['title', 'description', 'image_url'].filter((col) => !selectsColumn(tool.sql ?? '', col));
    if (missing.length) return { error: `${where}: action "${tool.name}" must select ${missing.join(', ')}` };
    routes.push({ path, action: tool.name, param, ...(not_found === 404 ? { not_found } : {}) });
  }

  if (site.sitemap === undefined || site.sitemap === null) return { routes, sitemap: null };
  if (typeof site.sitemap !== 'object' || Array.isArray(site.sitemap)) return { error: 'sitemap must be an object' };
  const tool = publicQueryAction(tools, (site.sitemap as Record<string, unknown>).action, 'sitemap');
  if (typeof tool === 'string') return { error: tool };
  if (!tool.params?.cursor) return { error: `sitemap: action "${tool.name}" must declare a cursor param (keyset paging: WHERE path > :cursor ORDER BY path)` };
  const missing = ['path', 'updated_at'].filter((col) => !selectsColumn(tool.sql ?? '', col));
  if (missing.length) return { error: `sitemap: action "${tool.name}" must select ${missing.join(', ')}` };
  return { routes, sitemap: tool.name };
}
