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

import { type Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { HttpError, requireAppOwner } from '../lib/auth.js';
import type { Env } from '../types.js';

export const domainRoutes = new Hono<{ Bindings: Env }>();

type Ctx = Context<{ Bindings: Env }>;

/** Direct CF Pages custom domains API call — no FAS admin proxy. */
async function cfPagesDomain(
  c: Ctx,
  proj: string,
  opts: { method: string; domain?: string; body?: unknown },
): Promise<{ status: number; body: unknown }> {
  const cfToken = c.env.CF_API_TOKEN;
  const cfAccount = c.env.CF_ACCOUNT_ID;
  if (!cfToken || !cfAccount) throw new HttpError('CF credentials not configured', 503);

  const path = opts.domain
    ? `/accounts/${cfAccount}/pages/projects/${encodeURIComponent(proj)}/domains/${encodeURIComponent(opts.domain)}`
    : `/accounts/${cfAccount}/pages/projects/${encodeURIComponent(proj)}/domains`;
  const init: RequestInit = { method: opts.method, headers: { Authorization: `Bearer ${cfToken}` } };
  if (opts.body !== undefined) {
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, init);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

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
//   - labels that start or end with a hyphen (RFC 1035)
// Permissive enough to accept apex (example.com) and subdomain (app.example.com)
// and IDN punycode (xn--).
//
// Each label: `[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?` — must start AND end
// with alphanumeric, hyphens allowed only in the interior.
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOSTNAME_RE = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})+$`);
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

function validateDomain(input: unknown): string {
  if (typeof input !== 'string') throw new HttpError('domain must be a string', 400);
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

// CF Pages' Domain object top-level field is `status`, one of:
//   'initializing' | 'pending' | 'active' | 'deactivated' | 'blocked' | 'error'
// We collapse that to our coarser 'pending' | 'active' | 'failed'. (Older
// `verification_status` is checked as a fallback in case a non-standard CF
// proxy or future API revision uses that name.)
function readCfStatus(result: any): string | null {
  return result?.status ?? result?.verification_status ?? null;
}

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
      if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
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
    const body = (await c.req.json().catch(() => ({}))) as { domain?: unknown };
    if (body.domain === undefined || body.domain === null) {
      throw new HttpError('domain required', 400);
    }
    const domain = validateDomain(body.domain);

    const cf = await cfPagesDomain(c, projectName(appId), {
      method: 'POST',
      body: { name: domain },
    });
    const { ok, result, error } = extractCfResult(cf.body);
    if (!ok) {
      // CF will say "Domain X is already attached to project Y" if it's
      // taken by another app — pass that through so the owner sees why.
      throw new HttpError(error || `CF returned ${cf.status}`, cf.status >= 400 && cf.status < 500 ? cf.status : 502);
    }

    const cfStatus = readCfStatus(result);
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
    // Auth check fires first so that an unauthenticated caller gets a
    // consistent 401 regardless of the input shape. Validating the URL
    // param before auth would leak "not a domain" → 400 to anyone.
    await requireAppOwner(c, appId);
    const domain = validateDomain(c.req.param('domain')!);
    const cf = await cfPagesDomain(c, projectName(appId), {
      method: 'PATCH',
      domain,
    });
    const { ok, result, error } = extractCfResult(cf.body);
    if (!ok) throw new HttpError(error || `CF returned ${cf.status}`, cf.status >= 400 && cf.status < 500 ? cf.status : 502);

    const cfStatus = readCfStatus(result);
    // Defensive: if CF returned a positive ack but no usable status (malformed
    // response, transient CF blip, schema drift), DO NOT persist — otherwise
    // a previously-active row would silently demote to 'pending' because
    // deriveStatus(null) === 'pending'. Return the existing row unchanged.
    if (!result || cfStatus === null) {
      const row = await c.env.DB.prepare(
        `SELECT app_id, domain, status, cf_status, cf_payload, added_at, verified_at
         FROM app_custom_domains WHERE app_id = ? AND domain = ?`,
      )
        .bind(appId, domain)
        .first<DomainRow>();
      if (!row) throw new HttpError('domain not attached to this app', 404);
      return c.json({ domain: dtoFromRow(row) });
    }

    const status = deriveStatus(cfStatus);
    const now = Date.now();
    const updated = await c.env.DB.prepare(
      `UPDATE app_custom_domains
       SET status = ?, cf_status = ?, cf_payload = ?,
           verified_at = CASE WHEN ? = 'active' AND verified_at IS NULL THEN ? ELSE verified_at END
       WHERE app_id = ? AND domain = ?`,
    )
      .bind(status, cfStatus, JSON.stringify(result), status, now, appId, domain)
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

// DELETE /v1/apps/:appId/domains/:domain — detach. Removes from CF Pages
// and from our table. Idempotent — a 404 from CF is treated as success
// since "already not attached" is the desired end state.
domainRoutes.delete(
  '/apps/:appId/domains/:domain',
  wrap(async (c) => {
    const appId = c.req.param('appId')!;
    // Auth first — see /verify route for rationale.
    await requireAppOwner(c, appId);
    const domain = validateDomain(c.req.param('domain')!);
    const cf = await cfPagesDomain(c, projectName(appId), {
      method: 'DELETE',
      domain,
    });
    // Admin Worker collapses CF's 404 (already-not-attached) to 200, so any
    // 4xx/5xx that reaches us is a real failure — domain locked, permission
    // denied, etc. Surface it; do NOT delete the DB row, otherwise CF and
    // our table diverge and the owner gets a fake "Detached" message.
    if (cf.status >= 400) {
      const { error } = extractCfResult(cf.body);
      throw new HttpError(
        error || `CF returned ${cf.status}`,
        cf.status < 500 ? cf.status : 502,
      );
    }
    await c.env.DB.prepare(`DELETE FROM app_custom_domains WHERE app_id = ? AND domain = ?`)
      .bind(appId, domain)
      .run();
    return c.json({ ok: true, domain });
  }),
);
