import { Hono } from 'hono';
import type { Env } from '../types.js';
import { HttpError, requireUser } from '../lib/auth.js';
import { wrap } from '../lib/route-wrap.js';
import { roleSubjects } from '../lib/role-subject.js';
import { APP_ID_PATTERN, APP_ORG } from '../lib/app-deploy-oidc.js';

/**
 * The creator-console app directory (#424): every app the caller can reach —
 * created, team, operator (admin_access role), offered to them by a pending
 * ownership transfer — plus their drafts, searchable and filterable, with
 * only non-sensitive summary fields.
 *
 * A search that names one exact id (the id itself, its live URL, its GitHub
 * URL or its store page) also answers whether that id is free: `unclaimed`,
 * `reserved` by the platform, or `exists_inaccessible` — taken by someone
 * else. The last says nothing about who holds it; it points at the recovery
 * request (#423) instead.
 */
export const appDirectoryRoutes = new Hono<{ Bindings: Env }>();

const DOMAIN = 'proappstore.online';
const CONSOLE = 'https://console.proappstore.online';
/** Hostnames the platform serves itself (packages/host/src/index.ts). */
export const RESERVED_IDS = new Set(['admin', 'agents', 'api', 'console', 'dashboard', 'docs', 'kb', 'mcp', 'www']);
/** `data-<app>` and `about-<app>` hosts belong to another app's data worker and marketing site. */
const RESERVED_PREFIXES = ['data-', 'about-'];

export const LIFECYCLES = ['draft', 'provisioned', 'deployed', 'live', 'failed', 'unpublished', 'archived'] as const;
export type Lifecycle = (typeof LIFECYCLES)[number];
export const ACCESS_FILTERS = ['mine', 'team', 'operator', 'transfer', 'inaccessible'] as const;
export type AccessFilter = (typeof ACCESS_FILTERS)[number];
export type AccessLevel = 'owner' | 'team' | 'operator' | 'transfer_recipient' | 'inaccessible';
export type LookupStatus = 'yours' | 'accessible' | 'exists_inaccessible' | 'unclaimed' | 'reserved' | 'invalid';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface DirectorySignals {
  hasAppRow: boolean;
  provisionStatus: string | null;
  lastDeployAt: number | null;
  submissionStatus: string | null;
  /** app_storefront_publication.listed: null = never recorded (never listed). */
  listed: number | null;
}

/**
 * One lifecycle per app, first match wins:
 * - draft: no registry row yet (an agent project or an open provisioning plan);
 * - failed: its provisioning failed;
 * - live: listed on the storefront (the authoritative flag, #399);
 * - unpublished: in the store pipeline (a submission pending, approved, rejected
 *   or published) but not listed;
 * - archived: delisted — `listed = 0` is only ever written by an unlisting —
 *   with no submission still in review;
 * - deployed: a CI deploy has run, never submitted;
 * - provisioned: registered, nothing deployed yet.
 * `down` is not stored anywhere: route health is a live check (MCP `app_info`, `find_apps` with check_health).
 */
export function classifyLifecycle(s: DirectorySignals): Lifecycle {
  if (!s.hasAppRow) return 'draft';
  if (s.provisionStatus === 'failed') return 'failed';
  if (s.listed === 1) return 'live';
  const inReview = s.submissionStatus === 'pending' || s.submissionStatus === 'approved';
  if (s.listed === 0 && !inReview) return 'archived';
  if (s.submissionStatus) return 'unpublished';
  if (s.lastDeployAt) return 'deployed';
  return 'provisioned';
}

function deployStatus(s: DirectorySignals): 'not_provisioned' | 'provisioning' | 'provision_failed' | 'deployed' | 'not_deployed' {
  if (!s.hasAppRow) return 'not_provisioned';
  if (s.provisionStatus === 'failed') return 'provision_failed';
  if (s.provisionStatus === 'pending') return 'provisioning';
  return s.lastDeployAt ? 'deployed' : 'not_deployed';
}

/**
 * The single app id a search names, when it names one: the id itself, its live
 * URL (`<id>.proappstore.online`, or its `data-`/`about-` hosts), its store page
 * (`proappstore.online/apps/<id>`) or its repository (`github.com/proappstore-online/<id>`).
 * Null for free text.
 */
export function exactIdFrom(q: string): string | null {
  const s = q.trim().toLowerCase().replace(/\/+$/, '');
  if (!s) return null;
  const repo = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/proappstore-online\/([a-z0-9-]+?)(?:\.git)?(?:\/.*)?$/);
  if (repo) return repo[1]!;
  const store = s.match(/^(?:https?:\/\/)?(?:www\.)?proappstore\.online\/apps\/([a-z0-9-]+)(?:\/.*)?$/);
  if (store) return store[1]!;
  const host = s.match(/^(?:https?:\/\/)?([a-z0-9-]+)\.proappstore\.online(?:[/?#].*)?$/);
  if (host) {
    const sub = host[1]!;
    for (const p of RESERVED_PREFIXES) if (sub.startsWith(p) && sub.length > p.length) return sub.slice(p.length);
    return sub;
  }
  return APP_ID_PATTERN.test(s) ? s : null;
}

export function isReservedId(id: string): boolean {
  return RESERVED_IDS.has(id) || RESERVED_PREFIXES.some((p) => id.startsWith(p));
}

function parseList<T extends string>(raw: string | undefined, allowed: readonly T[], name: string): Set<T> | null {
  if (!raw) return null;
  const values = raw.split(',').map((v) => v.trim()).filter(Boolean);
  for (const v of values) {
    if (!(allowed as readonly string[]).includes(v)) throw new HttpError(`unknown ${name} "${v}": one of ${allowed.join(', ')}`, 400);
  }
  return values.length ? new Set(values as T[]) : null;
}

interface AppSignalRow {
  id: string;
  created_at: number;
  is_owner: number;
  team_role: string | null;
  operator: number;
  incoming_transfer: number;
  outgoing_transfer: number;
  display_name: string | null;
  submission_status: string | null;
  listed: number | null;
  provision_status: string | null;
  last_deploy_at: number | null;
}

export interface DirectoryItem {
  id: string;
  displayName: string;
  lifecycle: Lifecycle | null;
  deployStatus: string | null;
  lastDeployAt: number | null;
  submissionStatus: string | null;
  accessLevel: AccessLevel;
  teamRole: string | null;
  pendingTransfer: 'incoming' | 'outgoing' | null;
  routeUrl: string;
  /** Route health is never stored; ask MCP `app_info` / `find_apps` (check_health) for a live check. */
  routeHealth: null;
  repoRef: string | null;
  links: { details: string | null; deployHistory: string | null; ownership: string; storePage: string | null; repository: string | null };
  createdAt: number | null;
}

function titleCase(id: string): string {
  return id.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function present(row: AppSignalRow | null, draft: { id: string; name: string | null; created_at: number } | null): DirectoryItem {
  const id = row?.id ?? draft!.id;
  const signals: DirectorySignals = row
    ? { hasAppRow: true, provisionStatus: row.provision_status, lastDeployAt: row.last_deploy_at, submissionStatus: row.submission_status, listed: row.listed }
    : { hasAppRow: false, provisionStatus: null, lastDeployAt: null, submissionStatus: null, listed: null };
  const accessLevel: AccessLevel = !row ? 'owner'
    : row.is_owner ? 'owner'
      : row.team_role ? 'team'
        : row.operator ? 'operator'
          : 'transfer_recipient';
  const manages = accessLevel === 'owner' || accessLevel === 'team';
  const lifecycle = classifyLifecycle(signals);
  const repoRef = row ? `${APP_ORG}/${id}` : null;
  return {
    id,
    displayName: row?.display_name ?? draft?.name ?? titleCase(id),
    lifecycle,
    deployStatus: deployStatus(signals),
    lastDeployAt: signals.lastDeployAt,
    submissionStatus: signals.submissionStatus,
    accessLevel,
    teamRole: row?.is_owner ? 'owner' : row?.team_role ?? null,
    pendingTransfer: row?.incoming_transfer ? 'incoming' : row?.outgoing_transfer ? 'outgoing' : null,
    routeUrl: `https://${id}.${DOMAIN}`,
    routeHealth: null,
    repoRef: manages ? repoRef : null,
    links: {
      details: accessLevel === 'operator' ? `${CONSOLE}/#/apps/${id}/operator` : accessLevel === 'transfer_recipient' ? null : `${CONSOLE}/#/apps/${id}`,
      deployHistory: manages && row ? `https://github.com/${APP_ORG}/${id}/actions` : null,
      ownership: `/v1/apps/${id}/ownership`,
      storePage: lifecycle === 'live' ? `https://${DOMAIN}/apps/${id}/` : null,
      repository: manages && row ? `https://github.com/${APP_ORG}/${id}` : null,
    },
    createdAt: row?.created_at ?? draft?.created_at ?? null,
  };
}

/** An id the caller cannot reach: only what is public — its route, and its store page if listed. */
function presentInaccessible(id: string, listed: boolean): DirectoryItem {
  return {
    id,
    displayName: id,
    lifecycle: listed ? 'live' : null,
    deployStatus: null,
    lastDeployAt: null,
    submissionStatus: null,
    accessLevel: 'inaccessible',
    teamRole: null,
    pendingTransfer: null,
    routeUrl: `https://${id}.${DOMAIN}`,
    routeHealth: null,
    repoRef: null,
    links: { details: null, deployHistory: null, ownership: `/v1/apps/${id}/ownership`, storePage: listed ? `https://${DOMAIN}/apps/${id}/` : null, repository: null },
    createdAt: null,
  };
}

async function accessibleApps(db: D1Database, user: { id: string; login: string }, now: number): Promise<AppSignalRow[]> {
  const [uid, alias] = roleSubjects(user);
  const { results } = await db.prepare(
    `WITH reach AS (
       SELECT id AS app_id FROM apps WHERE creator_id = ?1
       UNION SELECT app_id FROM team_members WHERE user_id = ?1
       UNION SELECT a.id FROM apps a JOIN app_operator_view v ON v.app_id = a.id
              WHERE EXISTS (SELECT 1 FROM json_each(v.contract, '$.admin_access.roles') declared
                              JOIN app_roles r ON r.app_id = a.id AND r.role_name = declared.value
                             WHERE r.user_id = ?1 OR r.user_id = ?2)
       UNION SELECT app_id FROM app_ownership_transfers
              WHERE to_user = ?1 AND kind = 'transfer' AND status = 'pending' AND (expiry_ms IS NULL OR expiry_ms > ?3)
     )
     SELECT a.id, a.created_at,
            a.creator_id = ?1 AS is_owner,
            (SELECT role FROM team_members tm WHERE tm.app_id = a.id AND tm.user_id = ?1) AS team_role,
            EXISTS (SELECT 1 FROM app_operator_view v WHERE v.app_id = a.id
                      AND EXISTS (SELECT 1 FROM json_each(v.contract, '$.admin_access.roles') declared
                                    JOIN app_roles r ON r.app_id = a.id AND r.role_name = declared.value
                                   WHERE r.user_id = ?1 OR r.user_id = ?2)) AS operator,
            EXISTS (SELECT 1 FROM app_ownership_transfers t WHERE t.app_id = a.id AND t.to_user = ?1 AND t.kind = 'transfer'
                      AND t.status = 'pending' AND (t.expiry_ms IS NULL OR t.expiry_ms > ?3)) AS incoming_transfer,
            EXISTS (SELECT 1 FROM app_ownership_transfers t WHERE t.app_id = a.id AND t.from_user = ?1 AND t.kind = 'transfer'
                      AND t.status = 'pending' AND (t.expiry_ms IS NULL OR t.expiry_ms > ?3)) AS outgoing_transfer,
            (SELECT s.name FROM submissions s WHERE s.app_id = a.id ORDER BY s.created_at DESC LIMIT 1) AS display_name,
            (SELECT s.status FROM submissions s WHERE s.app_id = a.id ORDER BY s.created_at DESC LIMIT 1) AS submission_status,
            p.listed,
            (SELECT o.status FROM provision_operations o WHERE o.app_id = a.id) AS provision_status,
            (SELECT MAX(d.minted_at) FROM deploy_audit d WHERE d.app_id = a.id) AS last_deploy_at
       FROM apps a
       JOIN reach ON reach.app_id = a.id
       LEFT JOIN app_storefront_publication p ON p.app_id = a.id`,
  ).bind(uid, alias, now).all<AppSignalRow>();
  return results ?? [];
}

/** The caller's drafts: agent projects and open provisioning plans with no registry row yet. */
async function drafts(db: D1Database, userId: string, now: number): Promise<{ id: string; name: string | null; created_at: number }[]> {
  const { results } = await db.prepare(
    `SELECT slug AS id, name, created_at FROM agent_projects
      WHERE owner_id = ?1 AND NOT EXISTS (SELECT 1 FROM apps WHERE id = agent_projects.slug)
     UNION
     SELECT app_id AS id, NULL AS name, MIN(created_at) AS created_at FROM provisioning_plans
      WHERE user_id = ?1 AND confirmed_at IS NULL AND expires_at > ?2
        AND NOT EXISTS (SELECT 1 FROM apps WHERE id = provisioning_plans.app_id)
        AND NOT EXISTS (SELECT 1 FROM agent_projects WHERE slug = provisioning_plans.app_id)
      GROUP BY app_id`,
  ).bind(userId, now).all<{ id: string; name: string | null; created_at: number }>();
  return results ?? [];
}

/** Whether anyone holds an id: a registry row, a provisioning claim, or an agent project. Never who. */
async function idTaken(db: D1Database, id: string): Promise<{ taken: boolean; listed: boolean }> {
  const row = await db.prepare(
    `SELECT
       EXISTS (SELECT 1 FROM apps WHERE id = ?1)
         OR EXISTS (SELECT 1 FROM provision_operations WHERE app_id = ?1)
         OR EXISTS (SELECT 1 FROM agent_projects WHERE slug = ?1) AS taken,
       COALESCE((SELECT listed FROM app_storefront_publication WHERE app_id = ?1), 0) AS listed`,
  ).bind(id).first<{ taken: number; listed: number }>();
  return { taken: !!row?.taken, listed: row?.listed === 1 };
}

function matchesText(item: DirectoryItem, needle: string, domainsById: Map<string, string[]>): boolean {
  return item.id.includes(needle)
    || item.displayName.toLowerCase().includes(needle)
    || (domainsById.get(item.id) ?? []).some((d) => d.includes(needle));
}

/**
 * GET /v1/apps/directory?q=&status=&access=&limit=
 *
 * `status` and `access` take one value or a comma-separated list. The response
 * is never cached: it is the caller's own view.
 */
appDirectoryRoutes.get('/apps/directory', wrap(async (c) => {
  const user = await requireUser(c);
  const q = (c.req.query('q') ?? '').trim();
  if (q.length > 200) throw new HttpError('q must be at most 200 characters', 400);
  const statuses = parseList(c.req.query('status'), LIFECYCLES, 'status');
  const access = parseList(c.req.query('access'), ACCESS_FILTERS, 'access');
  const rawLimit = c.req.query('limit');
  const limit = rawLimit === undefined ? DEFAULT_LIMIT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new HttpError(`limit must be an integer from 1 to ${MAX_LIMIT}`, 400);

  const now = Date.now();
  const db = c.env.DB;
  const [rows, draftRows] = await Promise.all([accessibleApps(db, user, now), drafts(db, user.id, now)]);
  let items = [...rows.map((r) => present(r, null)), ...draftRows.map((d) => present(null, d))];

  // Custom domains are searchable too, for the apps the caller already reaches.
  const domainsById = new Map<string, string[]>();
  if (q && rows.length) {
    const ids = rows.map((r) => r.id);
    const { results } = await db.prepare(
      `SELECT app_id, domain FROM app_custom_domains WHERE app_id IN (${ids.map(() => '?').join(', ')})`,
    ).bind(...ids).all<{ app_id: string; domain: string }>();
    for (const r of results ?? []) domainsById.set(r.app_id, [...(domainsById.get(r.app_id) ?? []), r.domain.toLowerCase()]);
  }

  const exact = q ? exactIdFrom(q) : null;
  const customDomainHit = q
    ? [...domainsById].find(([, ds]) => ds.some((d) => q.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '') === d))?.[0] ?? null
    : null;
  // Only something that names a PAS host, store page or org repository is held to one id.
  const urlShaped = /proappstore\.online|github\.com/i.test(q) || customDomainHit !== null;
  if (q) {
    const needle = q.toLowerCase();
    items = items.filter((i) =>
      customDomainHit ? i.id === customDomainHit
        : exact && urlShaped ? i.id === exact
          : matchesText(i, needle, domainsById));
  }

  // The exact-id answer: is the id this search names free, the platform's, yours, or someone else's?
  let lookup: { id: string; status: LookupStatus } | null = null;
  const lookupId = customDomainHit ?? exact;
  if (q && (lookupId || urlShaped)) {
    if (!lookupId || lookupId.length > 58) {
      lookup = { id: lookupId ?? q, status: 'invalid' };
    } else {
      const mine = [...rows.map((r) => present(r, null)), ...draftRows.map((d) => present(null, d))].find((i) => i.id === lookupId);
      if (mine) lookup = { id: lookupId, status: mine.accessLevel === 'owner' ? 'yours' : 'accessible' };
      else if (isReservedId(lookupId)) lookup = { id: lookupId, status: 'reserved' };
      else {
        const { taken, listed } = await idTaken(db, lookupId);
        lookup = { id: lookupId, status: taken ? 'exists_inaccessible' : 'unclaimed' };
        if (taken) items.push(presentInaccessible(lookupId, listed));
      }
    }
  }

  if (statuses) items = items.filter((i) => i.lifecycle !== null && statuses.has(i.lifecycle));
  if (access) {
    items = items.filter((i) =>
      (access.has('mine') && i.accessLevel === 'owner')
      || (access.has('team') && i.accessLevel === 'team')
      || (access.has('operator') && i.accessLevel === 'operator')
      || (access.has('transfer') && i.pendingTransfer !== null)
      || (access.has('inaccessible') && i.accessLevel === 'inaccessible'));
  }

  const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
  items.sort((a, b) =>
    Number(b.id === lookupId) - Number(a.id === lookupId)
    || collator.compare(a.displayName, b.displayName)
    || collator.compare(a.id, b.id));

  c.header('Cache-Control', 'private, no-store');
  return c.json({
    query: q || null,
    filters: { status: statuses ? [...statuses] : null, access: access ? [...access] : null },
    lookup,
    total: items.length,
    items: items.slice(0, limit),
    truncated: items.length > limit,
  });
}));
