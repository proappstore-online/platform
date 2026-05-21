// BYO custom domains for Pro apps.
//
//   POST   /v1/apps/:appId/domains            { domain }        — attach
//   GET    /v1/apps/:appId/domains                              — list + state
//   POST   /v1/apps/:appId/domains/:domain/verify              — re-check CF status
//   DELETE /v1/apps/:appId/domains/:domain                     — detach
//
// All mutating routes are owner-only (`requireAppOwner`). CF Pages is the
// source of truth for verification + cert state; this route caches the
// last-known state in `app_custom_domains` and surfaces CF's DNS instructions
// (`verification_data`, `validation_data`) back to the CLI/UI so the owner
// knows which records to add at their registrar.
//
// CF API is talked to via the FAS admin Worker's /api/apps/:proj/domains
// proxy through the ADMIN service binding — PAS never holds CF credentials.

import { type Context, Hono } from 'hono';
import { HttpError, requireAppOwner } from '../lib/auth.js';
import { callAdminDomain } from '../lib/provision-client.js';
import type { Env } from '../types.js';

export const domainRoutes = new Hono<{ Bindings: Env }>();

type Ctx = Context<{ Bindings: Env }>;

interface DomainRow {
  app_id: string;
  domain: string;
  status: string;
  cf_status: string | null;
  cf_payload: string | null;
  added_at: number;
  verified_at: number | null;
}

interface DomainDto {
  domain: string;
  status: 'pending' | 'active' | 'failed';
  cfStatus: string | null;
  verificationData: unknown;
  validationData: unknown;
  certificateAuthority: string | null;
  addedAt: number;
  verifiedAt: number | null;
}

// Lowercased, no path, no port. Reject:
//   - empty / whitespace
//   - IP addresses (CF Pages won't accept these anyway)
//   - localhost / .local / .test / .invalid
//   - our own platform domains (would shadow store routing)
//   - hostnames over 253 chars (DNS limit)
// Permissive enough to accept apex (example.com) and subdomain (app.example.com)
// and IDN punycode (xn--).
const HOSTNAME_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})+$/;
const RESERVED_TLDS = new Set(['local', 'localhost', 'test', 'invalid', 'example']);
const PLATFORM_DOMAINS = [
  'proappstore.online',
  'freeappstore.online',
  'freegamestore.online',
  'freewebstore.online',
  'prowebstore.online',
  'pages.dev',
  'workers.dev',
];

function validateDomain(input: string): string {
  const domain = input.toLowerCase().trim().replace(/\.$/, '');
  if (!HOSTNAME_RE.test(domain)) throw new HttpError('invalid domain', 400);
  // Reject IPs (HOSTNAME_RE accepts "1.2.3.4" because it's all digits + dots).
  if (/^\d+(\.\d+){3}$/.test(domain)) throw new HttpError('IP addresses are not custom domains', 400);
  const tld = domain.split('.').pop()!;
  if (RESERVED_TLDS.has(tld)) throw new HttpError(`reserved TLD: .${tld}`, 400);
  for (const reserved of PLATFORM_DOMAINS) {
    if (domain === reserved || domain.endsWith(`.${reserved}`)) {
      throw new HttpError(`${reserved} is platform-managed`, 400);
    }
  }
  return domain;
}

function projectName(appId: string): string {
  return `proappstore-${appId}`;
}

// Map a CF /domains response (POST or GET) into our row shape + DTO. CF
// returns verification_status one of:
//   'active' | 'pending' | 'deactivated' | 'blocked' | 'error'
// We collapse to: 'active' | 'pending' | 'failed'.
function deriveStatus(cfStatus: string | null | undefined): 'pending' | 'active' | 'failed' {
  if (cfStatus === 'active') return 'active';
  if (cfStatus === 'pending' || cfStatus === 'initializing' || !cfStatus) return 'pending';
  return 'failed';
}

function dtoFromRow(row: DomainRow): DomainDto {
  let payload: any = null;
  if (row.cf_payload) {
    try {
      payload = JSON.parse(row.cf_payload);
    } catch {
      payload = null;
    }
  }
  return {
    domain: row.domain,
    status: row.status as DomainDto['status'],
    cfStatus: row.cf_status,
    verificationData: payload?.verification_data ?? null,
    validationData: payload?.validation_data ?? null,
    certificateAuthority: payload?.certificate_authority ?? null,
    addedAt: row.added_at,
    verifiedAt: row.verified_at,
  };
}

// Pull the result object out of CF's wrapper. CF responds with either
//   { success: true, result: {...} }       — POST/GET success
//   { success: true, result: null }        — DELETE success (sometimes)
//   { success: false, errors: [{code,message}] }
function extractCfResult(body: unknown): { ok: boolean; result: any; error: string | null } {
  if (!body || typeof body !== 'object') return { ok: false, result: null, error: 'invalid response from admin' };
  const b = body as any;
  if (b.success === true) return { ok: true, result: b.result ?? null, error: null };
  const msg = b.errors?.[0]?.message || b.error || b.detail || 'CF API call failed';
  return { ok: false, result: null, error: String(msg) };
}

function wrap(handler: (c: Ctx) => Promise<Response>) {
  return async (c: Ctx) => {
    try {
      return await handler(c);
    } catch (err) {
      if (err instanceof HttpError) return c.text(err.message, err.status as 401);
      throw err;
    }
  };
}

// POST /v1/apps/:appId/domains — attach a custom domain. Idempotent: if the
// domain is already attached to this app, returns the current state. If it's
// attached to a different app (or different CF project entirely), CF rejects
// with a 409-ish error and we surface that.
domainRoutes.post(
  '/apps/:appId/domains',
  wrap(async (c) => {
    const appId = c.req.param('appId')!;
    await requireAppOwner(c, appId);
    if (!c.env.ADMIN) {
      throw new HttpError('admin binding not configured — custom domains unavailable in this env', 503);
    }
    const body = (await c.req.json().catch(() => ({}))) as { domain?: string };
    if (!body.domain) throw new HttpError('domain required', 400);
    const domain = validateDomain(body.domain);

    const cf = await callAdminDomain(c.env.ADMIN, projectName(appId), {
      method: 'POST',
      body: { name: domain },
    });
    const { ok, result, error } = extractCfResult(cf.body);
    if (!ok) {
      // CF will say "Domain X is already attached to project Y" if it's
      // taken by another app — pass that through so the owner sees why.
      throw new HttpError(error || `CF returned ${cf.status}`, cf.status >= 400 && cf.status < 500 ? cf.status : 502);
    }

    const cfStatus = result?.verification_status ?? null;
    const status = deriveStatus(cfStatus);
    const now = Date.now();
    await c.env.DB.prepare(
      `INSERT INTO app_custom_domains (app_id, domain, status, cf_status, cf_payload, added_at, verified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(app_id, domain) DO UPDATE SET
         status = excluded.status,
         cf_status = excluded.cf_status,
         cf_payload = excluded.cf_payload,
         verified_at = CASE WHEN excluded.status = 'active' THEN excluded.verified_at ELSE app_custom_domains.verified_at END`,
    )
      .bind(appId, domain, status, cfStatus, JSON.stringify(result ?? {}), now, status === 'active' ? now : null)
      .run();

    const row = await c.env.DB.prepare(
      `SELECT app_id, domain, status, cf_status, cf_payload, added_at, verified_at
       FROM app_custom_domains WHERE app_id = ? AND domain = ?`,
    )
      .bind(appId, domain)
      .first<DomainRow>();
    return c.json({ domain: dtoFromRow(row!) }, 201);
  }),
);

// GET /v1/apps/:appId/domains — list custom domains for this app. Owner-only
// because the verification payload contains DNS records the owner needs to add
// privately. No CF round-trip — clients call /verify when they want fresh data.
domainRoutes.get(
  '/apps/:appId/domains',
  wrap(async (c) => {
    const appId = c.req.param('appId')!;
    await requireAppOwner(c, appId);
    const rows = await c.env.DB.prepare(
      `SELECT app_id, domain, status, cf_status, cf_payload, added_at, verified_at
       FROM app_custom_domains WHERE app_id = ? ORDER BY added_at ASC`,
    )
      .bind(appId)
      .all<DomainRow>();
    return c.json({ domains: (rows.results ?? []).map(dtoFromRow) });
  }),
);

// POST /v1/apps/:appId/domains/:domain/verify — ask CF to re-check the
// domain's DNS / cert state. Use this after the owner has added the records
// CF requested. Persists the new state.
domainRoutes.post(
  '/apps/:appId/domains/:domain/verify',
  wrap(async (c) => {
    const appId = c.req.param('appId')!;
    const domain = c.req.param('domain')!.toLowerCase();
    await requireAppOwner(c, appId);
    if (!c.env.ADMIN) throw new HttpError('admin binding not configured', 503);

    // Tell CF to re-verify (PATCH), then read the latest status (GET). PATCH
    // is the trigger; CF returns the verification result on the next GET.
    await callAdminDomain(c.env.ADMIN, projectName(appId), {
      method: 'PATCH',
      domain,
    });
    const cf = await callAdminDomain(c.env.ADMIN, projectName(appId), {
      method: 'GET',
      domain,
    });
    const { ok, result, error } = extractCfResult(cf.body);
    if (!ok) throw new HttpError(error || `CF returned ${cf.status}`, cf.status >= 400 && cf.status < 500 ? cf.status : 502);

    const cfStatus = result?.verification_status ?? null;
    const status = deriveStatus(cfStatus);
    const now = Date.now();
    const updated = await c.env.DB.prepare(
      `UPDATE app_custom_domains
       SET status = ?, cf_status = ?, cf_payload = ?,
           verified_at = CASE WHEN ? = 'active' AND verified_at IS NULL THEN ? ELSE verified_at END
       WHERE app_id = ? AND domain = ?`,
    )
      .bind(status, cfStatus, JSON.stringify(result ?? {}), status, now, appId, domain)
      .run();
    if ((updated.meta?.changes ?? 0) === 0) {
      throw new HttpError('domain not attached to this app', 404);
    }
    const row = await c.env.DB.prepare(
      `SELECT app_id, domain, status, cf_status, cf_payload, added_at, verified_at
       FROM app_custom_domains WHERE app_id = ? AND domain = ?`,
    )
      .bind(appId, domain)
      .first<DomainRow>();
    return c.json({ domain: dtoFromRow(row!) });
  }),
);

/**
 * Cron-callable: re-check every pending custom domain against CF Pages and
 * persist the new status. Returns a summary { checked, activated, stillPending,
 * failed, errors } so the cron handler can log it. Owners shouldn't have to
 * run `pas domain verify` manually — once they add the DNS records CF wants,
 * this loop catches it within the cron interval (typically 1h).
 *
 * Idempotent and tolerant of CF errors — one bad row doesn't poison the
 * sweep. The :domain/verify route is still useful for instant feedback;
 * this is the background convenience.
 */
export async function sweepPendingDomains(env: Env): Promise<{
  checked: number;
  activated: number;
  stillPending: number;
  failed: number;
  errors: string[];
}> {
  const summary = { checked: 0, activated: 0, stillPending: 0, failed: 0, errors: [] as string[] };
  if (!env.ADMIN) {
    summary.errors.push('ADMIN binding not configured');
    return summary;
  }
  const rows = await env.DB.prepare(
    `SELECT app_id, domain FROM app_custom_domains WHERE status = 'pending' OR status = 'failed' LIMIT 200`,
  ).all<{ app_id: string; domain: string }>();
  const items = rows.results ?? [];
  for (const item of items) {
    summary.checked++;
    try {
      await callAdminDomain(env.ADMIN, projectName(item.app_id), { method: 'PATCH', domain: item.domain });
      const cf = await callAdminDomain(env.ADMIN, projectName(item.app_id), { method: 'GET', domain: item.domain });
      const { ok, result } = extractCfResult(cf.body);
      const cfStatus = ok ? (result?.verification_status ?? null) : null;
      const status = deriveStatus(cfStatus);
      const now = Date.now();
      await env.DB.prepare(
        `UPDATE app_custom_domains
         SET status = ?, cf_status = ?, cf_payload = ?,
             verified_at = CASE WHEN ? = 'active' AND verified_at IS NULL THEN ? ELSE verified_at END
         WHERE app_id = ? AND domain = ?`,
      )
        .bind(status, cfStatus, JSON.stringify(result ?? {}), status, now, item.app_id, item.domain)
        .run();
      if (status === 'active') summary.activated++;
      else if (status === 'pending') summary.stillPending++;
      else summary.failed++;
    } catch (e) {
      summary.errors.push(`${item.app_id}/${item.domain}: ${(e as Error).message}`);
    }
  }
  return summary;
}

// DELETE /v1/apps/:appId/domains/:domain — detach. Removes from CF Pages
// and from our table. Idempotent — a 404 from CF is treated as success
// since "already not attached" is the desired end state.
domainRoutes.delete(
  '/apps/:appId/domains/:domain',
  wrap(async (c) => {
    const appId = c.req.param('appId')!;
    const domain = c.req.param('domain')!.toLowerCase();
    await requireAppOwner(c, appId);
    if (!c.env.ADMIN) throw new HttpError('admin binding not configured', 503);
    const cf = await callAdminDomain(c.env.ADMIN, projectName(appId), {
      method: 'DELETE',
      domain,
    });
    // Admin Worker already collapses 404→200 for us; anything else 5xx is
    // a real problem.
    if (cf.status >= 500) throw new HttpError(`CF returned ${cf.status}`, 502);
    await c.env.DB.prepare(`DELETE FROM app_custom_domains WHERE app_id = ? AND domain = ?`)
      .bind(appId, domain)
      .run();
    return c.json({ ok: true, domain });
  }),
);
