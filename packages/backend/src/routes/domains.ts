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

// Path B serves every app from R2 via one shared host worker. A BYO custom domain
// is a Worker Custom Domain bound to that worker; the host worker then resolves the
// hostname → app via `app_custom_domains`. (The old per-app CF-Pages-project path
// 404'd for Path B apps — they have no Pages project.)
const HOST_WORKER = 'proappstore-host';

/** Find the CF zone (in our account) that owns `domain`. The domain must be on
 *  Cloudflare — its nameservers pointed at CF — for a Worker Custom Domain to bind. */
async function cfZoneIdFor(c: Ctx, domain: string): Promise<string | null> {
  const cfToken = c.env.CF_API_TOKEN;
  if (!cfToken) throw new HttpError('CF credentials not configured', 503);
  const labels = domain.split('.');
  // app.ratemycup.online → try ratemycup.online first, then broader suffixes.
  for (let i = 0; i < labels.length - 1; i++) {
    const name = labels.slice(i).join('.');
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(name)}&status=active`,
      { headers: { Authorization: `Bearer ${cfToken}` } },
    );
    const body = (await res.json().catch(() => null)) as { result?: { id?: string }[] } | null;
    const id = body?.result?.[0]?.id;
    if (id) return id;
  }
  return null;
}

/** Bind / list / remove the host worker's Custom Domain for a hostname. */
async function workerDomain(
  c: Ctx,
  opts: { method: 'PUT' | 'GET' | 'DELETE'; domain: string; zoneId?: string; id?: string },
): Promise<{ status: number; body: any }> {
  const cfToken = c.env.CF_API_TOKEN;
  const cfAccount = c.env.CF_ACCOUNT_ID;
  if (!cfToken || !cfAccount) throw new HttpError('CF credentials not configured', 503);
  const base = `https://api.cloudflare.com/client/v4/accounts/${cfAccount}/workers/domains`;
  let url = base;
  const init: RequestInit = { method: opts.method, headers: { Authorization: `Bearer ${cfToken}` } };
  if (opts.method === 'PUT') {
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    init.body = JSON.stringify({ environment: 'production', hostname: opts.domain, service: HOST_WORKER, zone_id: opts.zoneId });
  } else if (opts.method === 'GET') {
    url = `${base}?hostname=${encodeURIComponent(opts.domain)}`;
  } else if (opts.method === 'DELETE') {
    url = `${base}/${opts.id}`;
  }
  const res = await fetch(url, init);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

// ── Cloudflare for SaaS (custom hostnames) ───────────────────────────────────
// For domains NOT on Cloudflare (DNS stays at the owner's registrar). The owner
// adds a CNAME → our SaaS target + a TXT for ownership/DCV; CF issues the cert and
// routes to the host worker. Requires "Cloudflare for SaaS" enabled on the account
// + a fallback origin on proappstore.online + a token with SSL:Edit.
const SAAS_ZONE_NAME = 'proappstore.online';

/** Proxied hostname on the SaaS zone that external domains CNAME to (owner sets it
 *  up alongside the fallback origin). Overridable via env. */
function saasCnameTarget(c: Ctx): string {
  return c.env.CF_SAAS_CNAME_TARGET || `cname.${SAAS_ZONE_NAME}`;
}

async function saasZoneId(c: Ctx): Promise<string | null> {
  const cfToken = c.env.CF_API_TOKEN;
  if (!cfToken) return null;
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/zones?name=${SAAS_ZONE_NAME}&status=active`,
    { headers: { Authorization: `Bearer ${cfToken}` } },
  );
  const body = (await res.json().catch(() => null)) as { result?: { id?: string }[] } | null;
  return body?.result?.[0]?.id ?? null;
}

/** Create / fetch / delete a Cloudflare-for-SaaS custom hostname on the SaaS zone. */
async function customHostname(
  c: Ctx,
  zoneId: string,
  opts: { method: 'POST' | 'GET' | 'DELETE'; hostname?: string; id?: string },
): Promise<{ status: number; body: any }> {
  const cfToken = c.env.CF_API_TOKEN;
  if (!cfToken) throw new HttpError('CF credentials not configured', 503);
  const base = `https://api.cloudflare.com/client/v4/zones/${zoneId}/custom_hostnames`;
  let url = base;
  const init: RequestInit = { method: opts.method, headers: { Authorization: `Bearer ${cfToken}` } };
  if (opts.method === 'POST') {
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    init.body = JSON.stringify({ hostname: opts.hostname, ssl: { method: 'txt', type: 'dv', settings: { min_tls_version: '1.2' } } });
  } else if (opts.method === 'GET') {
    url = opts.id ? `${base}/${opts.id}` : `${base}?hostname=${encodeURIComponent(opts.hostname!)}`;
  } else if (opts.method === 'DELETE') {
    url = `${base}/${opts.id}`;
  }
  const res = await fetch(url, init);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/** From a CF custom-hostname result, build the DNS records the owner must add. */
function saasPayload(c: Ctx, domain: string, result: any): Record<string, unknown> {
  const isApex = domain.split('.').length === 2;
  const txt: { name: string; value: string }[] = [];
  const dcv = result?.ssl?.validation_records?.[0];
  if (dcv?.txt_name && dcv?.txt_value) txt.push({ name: dcv.txt_name, value: dcv.txt_value });
  const ov = result?.ownership_verification;
  if (ov?.name && ov?.value) txt.push({ name: ov.name, value: ov.value });
  return {
    kind: 'saas',
    hostnameId: result?.id ?? null,
    apex: isApex,
    // Subdomains CNAME to our SaaS target; apex domains can't CNAME at most
    // registrars → the UI tells them to use CNAME flattening or move NS to CF.
    cname: isApex ? null : { name: domain, value: saasCnameTarget(c) },
    cnameTarget: saasCnameTarget(c),
    txt,
  };
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
  /** How the domain is wired: 'worker' = zone on CF (instant); 'saas' = external
   *  DNS, needs CNAME+TXT. */
  method: 'worker' | 'saas' | null;
  cfStatus: string | null;
  /** DNS records the owner must add (only for the 'saas' method while pending). */
  instructions: {
    apex: boolean;
    cname: { name: string; value: string } | null;
    cnameTarget: string;
    txt: { name: string; value: string }[];
  } | null;
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

function dtoFromRow(row: DomainRow): DomainDto {
  let payload: any = null;
  if (row.cf_payload) {
    try {
      payload = JSON.parse(row.cf_payload);
    } catch {
      payload = null;
    }
  }
  const kind: 'worker' | 'saas' | null = payload?.kind === 'saas' ? 'saas' : payload?.kind === 'worker' ? 'worker' : null;
  const instructions =
    kind === 'saas'
      ? {
          apex: !!payload.apex,
          cname: payload.cname ?? null,
          cnameTarget: payload.cnameTarget ?? '',
          txt: Array.isArray(payload.txt) ? payload.txt : [],
        }
      : null;
  return {
    domain: row.domain,
    status: row.status as DomainDto['status'],
    method: kind,
    cfStatus: row.cf_status,
    instructions,
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

    // Adaptive: if the domain's zone is already on Cloudflare (in our account) we
    // bind a Worker Custom Domain (instant, no DNS records for the owner to add).
    // Otherwise the DNS lives elsewhere → Cloudflare for SaaS custom hostname, and
    // we hand back the CNAME + TXT records for the owner to paste at their registrar.
    const zoneId = await cfZoneIdFor(c, domain);
    let cfStatus: string;
    let status: 'pending' | 'active' | 'failed';
    let payloadObj: Record<string, unknown>;

    if (zoneId) {
      const cf = await workerDomain(c, { method: 'PUT', domain, zoneId });
      const { ok, error } = extractCfResult(cf.body);
      if (!ok) throw new HttpError(error || `CF returned ${cf.status}`, cf.status >= 400 && cf.status < 500 ? cf.status : 502);
      cfStatus = 'active';
      status = 'active';
      payloadObj = { kind: 'worker' };
    } else {
      const saasZone = await saasZoneId(c);
      if (!saasZone) {
        throw new HttpError(
          'Custom domains for external DNS need Cloudflare for SaaS, which is not enabled yet. Move the domain to Cloudflare, or ask the platform owner to enable SaaS custom hostnames.',
          503,
        );
      }
      const cf = await customHostname(c, saasZone, { method: 'POST', hostname: domain });
      const { ok, result, error } = extractCfResult(cf.body);
      if (!ok) throw new HttpError(error || `CF returned ${cf.status}`, cf.status >= 400 && cf.status < 500 ? cf.status : 502);
      cfStatus = result?.ssl?.status ?? 'pending';
      status = 'pending';
      payloadObj = saasPayload(c, domain, result);
    }

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
      .bind(appId, domain, status, cfStatus, JSON.stringify(payloadObj), now, status === 'active' ? now : null)
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
    // Look up which path this domain uses, then re-check the right CF resource.
    const existing = await c.env.DB.prepare(
      `SELECT cf_payload FROM app_custom_domains WHERE app_id = ? AND domain = ?`,
    ).bind(appId, domain).first<{ cf_payload: string | null }>();
    if (!existing) throw new HttpError('domain not attached to this app', 404);
    let kind: string | null = null;
    try { kind = existing.cf_payload ? (JSON.parse(existing.cf_payload)?.kind ?? null) : null; } catch { kind = null; }

    let cfStatus: string;
    let status: 'pending' | 'active' | 'failed';
    let payloadJson: string;

    if (kind === 'saas') {
      const saasZone = await saasZoneId(c);
      const cf = saasZone
        ? await customHostname(c, saasZone, { method: 'GET', hostname: domain })
        : { status: 503, body: null };
      const list = Array.isArray(cf.body?.result) ? cf.body.result : [];
      const ch = list.find((h: any) => h?.hostname === domain) ?? null;
      cfStatus = ch?.ssl?.status ?? 'pending';
      status = ch?.status === 'active' && ch?.ssl?.status === 'active' ? 'active' : 'pending';
      payloadJson = ch ? JSON.stringify(saasPayload(c, domain, ch)) : (existing.cf_payload ?? '{}');
    } else {
      const cf = await workerDomain(c, { method: 'GET', domain });
      if (cf.status >= 400 && cf.status !== 404) throw new HttpError(`CF returned ${cf.status}`, cf.status < 500 ? cf.status : 502);
      const bindings = Array.isArray(cf.body?.result) ? cf.body.result : [];
      const found = bindings.find((d: any) => d?.hostname === domain && d?.service === HOST_WORKER) ?? null;
      cfStatus = found ? 'active' : 'pending';
      status = found ? 'active' : 'pending';
      payloadJson = JSON.stringify({ kind: 'worker' });
    }

    const now = Date.now();
    const updated = await c.env.DB.prepare(
      `UPDATE app_custom_domains
       SET status = ?, cf_status = ?, cf_payload = ?,
           verified_at = CASE WHEN ? = 'active' AND verified_at IS NULL THEN ? ELSE verified_at END
       WHERE app_id = ? AND domain = ?`,
    )
      .bind(status, cfStatus, payloadJson, status, now, appId, domain)
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
    // Remove the right CF resource for this domain's path. Idempotent: a missing
    // resource is the desired end state, so a 404 on delete is treated as success.
    const existing = await c.env.DB.prepare(
      `SELECT cf_payload FROM app_custom_domains WHERE app_id = ? AND domain = ?`,
    ).bind(appId, domain).first<{ cf_payload: string | null }>();
    let payload: any = null;
    try { payload = existing?.cf_payload ? JSON.parse(existing.cf_payload) : null; } catch { payload = null; }

    if (payload?.kind === 'saas') {
      const saasZone = await saasZoneId(c);
      if (saasZone && payload.hostnameId) {
        const del = await customHostname(c, saasZone, { method: 'DELETE', id: payload.hostnameId });
        if (del.status >= 400 && del.status !== 404) {
          const { error } = extractCfResult(del.body);
          throw new HttpError(error || `CF returned ${del.status}`, del.status < 500 ? del.status : 502);
        }
      }
    } else {
      const lookup = await workerDomain(c, { method: 'GET', domain });
      const bindings = Array.isArray(lookup.body?.result) ? lookup.body.result : [];
      const found = bindings.find((d: any) => d?.hostname === domain && d?.service === HOST_WORKER) ?? null;
      if (found?.id) {
        const del = await workerDomain(c, { method: 'DELETE', domain, id: found.id });
        if (del.status >= 400 && del.status !== 404) {
          const { error } = extractCfResult(del.body);
          throw new HttpError(error || `CF returned ${del.status}`, del.status < 500 ? del.status : 502);
        }
      }
    }
    await c.env.DB.prepare(`DELETE FROM app_custom_domains WHERE app_id = ? AND domain = ?`)
      .bind(appId, domain)
      .run();
    return c.json({ ok: true, domain });
  }),
);
