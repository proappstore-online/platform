/**
 * Versioned broker for a remote MCP client (#355).
 *
 * This is deliberately not OAuth Device Authorization: the existing MCP OAuth
 * provider remains standards-compatible and #356 adapts this result into its
 * authorization-code flow.  PAGS creates requests only with its owner's PAS
 * session; a machine can never nominate an owner by name.
 */
import { Hono } from 'hono';
import { mintSession } from '@proappstore/build-core';
import { requireUser } from '../lib/auth.js';
import { sha256Hex } from '../lib/app-tokens.js';
import type { Env } from '../types.js';

export const mcpBrokerRoutes = new Hono<{ Bindings: Env }>();

export const MCP_BROKER_VERSION = '2026-10-10';
const PREFIX = '/mcp/broker/v1/requests';
const MAX_TTL_MS = 10 * 60_000;
const MIN_TTL_MS = 60_000;
const RETRY_AFTER_MS = 2_000;
const requestIdRe = /^[A-Za-z0-9_-]{32,128}$/;
const hashRe = /^[a-f0-9]{64}$/;
const challengeRe = /^[A-Za-z0-9_-]{43,128}$/;
const labelRe = /^[\x20-\x7e]{1,120}$/;
const identityRe = /^[A-Za-z0-9._:-]{1,120}$/;
type Status = 'pending' | 'approved_awaiting_machine' | 'consumed' | 'connected' | 'denied' | 'expired' | 'cancelled' | 'failed';

interface BrokerRow {
  request_id: string; owner_id: string; agent_id: string; agent_label: string;
  machine_id: string; machine_label: string; resource: string; scopes: string;
  code_challenge: string; machine_proof_hash: string; status: Status; expires_at: number;
  result_iv: string | null; result_ciphertext: string | null;
}

function invalid(): Response { return Response.json({ error: 'invalid remote-auth request' }, { status: 400 }); }
function unavailable(): Response { return Response.json({ error: 'remote-auth result unavailable' }, { status: 409 }); }
function safeText(value: unknown, max = 120): string | null {
  return typeof value === 'string' && value.length <= max && labelRe.test(value) ? value : null;
}
function parseScopes(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) return null;
  const scopes = value.filter((scope): scope is string => typeof scope === 'string' && /^[a-z0-9:_./-]{1,100}$/.test(scope));
  return scopes.length === value.length && new Set(scopes).size === scopes.length ? scopes : null;
}
function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function fromBase64url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}
async function cryptoKey(signingKey: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`pas-mcp-broker-v1:${signingKey}`));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function seal(value: string, signingKey: string): Promise<{ iv: string; ciphertext: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await cryptoKey(signingKey), new TextEncoder().encode(value));
  return { iv: base64url(iv), ciphertext: base64url(new Uint8Array(ciphertext)) };
}
async function open(iv: string, ciphertext: string, signingKey: string): Promise<string | null> {
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64url(iv) }, await cryptoKey(signingKey), fromBase64url(ciphertext));
    return new TextDecoder().decode(plain);
  } catch { return null; }
}
async function markExpired(db: D1Database, requestId: string, now: number): Promise<void> {
  await db.prepare(`UPDATE mcp_remote_auth_requests SET status = 'expired', terminal_at = ?
    WHERE request_id = ? AND expires_at <= ? AND status IN ('pending', 'approved_awaiting_machine')`)
    .bind(now, requestId, now).run();
}
async function rowFor(db: D1Database, requestId: string, now: number): Promise<BrokerRow | null> {
  await markExpired(db, requestId, now);
  return db.prepare(`SELECT request_id, owner_id, agent_id, agent_label, machine_id, machine_label, resource, scopes,
    code_challenge, machine_proof_hash, status, expires_at, result_iv, result_ciphertext
    FROM mcp_remote_auth_requests WHERE request_id = ?`).bind(requestId).first<BrokerRow>();
}
async function machineRow(c: { env: Env; req: { json: () => Promise<unknown> } }): Promise<{ row: BrokerRow; body: Record<string, unknown> } | Response> {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') return invalid();
  const parsed = body as Record<string, unknown>;
  const requestId = parsed.request_id;
  const proof = parsed.machine_proof;
  if (typeof requestId !== 'string' || !requestIdRe.test(requestId) || typeof proof !== 'string' || proof.length < 43 || proof.length > 256) return invalid();
  const row = await rowFor(c.env.DB, requestId, Date.now());
  // Deliberately uniform: a proof holder learns no difference between a typo,
  // wrong request, and a request for somebody else's machine.
  if (!row || await sha256Hex(proof) !== row.machine_proof_hash) return unavailable();
  return { row, body: parsed };
}
function machineStatus(row: BrokerRow) {
  return { protocol_version: MCP_BROKER_VERSION, request_id: row.request_id, status: row.status, retry_after_ms: RETRY_AFTER_MS, expires_at: row.expires_at };
}
function hostedStatusPage(status: string): Response {
  const visible = ['pending', 'approved_awaiting_machine', 'consumed', 'connected', 'denied', 'expired', 'cancelled', 'failed'].includes(status) ? status : 'not_found';
  const text = visible.replaceAll('_', ' ');
  return new Response(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>ProAppStore connection</title><main><h1>ProAppStore connection</h1><p>Status: ${text}</p><p>You may return to ProAppStore.</p></main>`, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
  });
}

/** PAGS calls this with the existing authenticated owner's PAS bearer. */
mcpBrokerRoutes.post(PREFIX, async (c) => {
  const owner = await requireUser(c);
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  const requestId = body?.request_id;
  const agent = body?.agent as Record<string, unknown> | undefined;
  const machine = body?.machine as Record<string, unknown> | undefined;
  const resource = safeText(body?.resource, 400);
  const scopes = parseScopes(body?.scopes);
  const challenge = body?.code_challenge;
  const proofHash = body?.machine_proof_hash;
  const ttl = typeof body?.expires_in_ms === 'number' ? body.expires_in_ms : MAX_TTL_MS;
  if (typeof requestId !== 'string' || !requestIdRe.test(requestId) || !agent || !machine || !resource || !scopes
    || typeof challenge !== 'string' || !challengeRe.test(challenge) || typeof proofHash !== 'string' || !hashRe.test(proofHash)
    || !Number.isInteger(ttl) || ttl < MIN_TTL_MS || ttl > MAX_TTL_MS
    || typeof agent.id !== 'string' || !identityRe.test(agent.id) || !safeText(agent.label)
    || typeof machine.id !== 'string' || !identityRe.test(machine.id) || !safeText(machine.label)) return invalid();
  const now = Date.now();
  try {
    await c.env.DB.prepare(`INSERT INTO mcp_remote_auth_requests
      (request_id, owner_id, agent_id, agent_label, machine_id, machine_label, resource, scopes, code_challenge, machine_proof_hash, status, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
      .bind(requestId, owner.id, agent.id, agent.label, machine.id, machine.label, resource, JSON.stringify(scopes), challenge, proofHash, now + ttl, now).run();
  } catch { return Response.json({ error: 'request_id already exists' }, { status: 409 }); }
  const base = c.env.APP_BASE ?? new URL(c.req.url).origin;
  return c.json({ protocol_version: MCP_BROKER_VERSION, request_id: requestId, status: 'pending', expires_at: now + ttl,
    status_url: `${base}${PREFIX}/${encodeURIComponent(requestId)}/status` }, 201);
});

/** The PAGS deep-link page reads the immutable target with the owner's bearer. */
mcpBrokerRoutes.get(`${PREFIX}/:requestId`, async (c) => {
  const owner = await requireUser(c); const requestId = c.req.param('requestId');
  if (!requestIdRe.test(requestId)) return unavailable();
  const row = await rowFor(c.env.DB, requestId, Date.now());
  if (!row || row.owner_id !== owner.id) return unavailable();
  let scopes: unknown;
  try { scopes = JSON.parse(row.scopes); } catch { return unavailable(); }
  if (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === 'string')) return unavailable();
  return c.json({ protocol_version: MCP_BROKER_VERSION, request_id: row.request_id, status: row.status,
    agent: { id: row.agent_id, label: row.agent_label }, machine: { id: row.machine_id, label: row.machine_label },
    resource: row.resource, scopes, expires_at: row.expires_at });
});

/** PAGS request page calls this after showing its authenticated owner the target. */
mcpBrokerRoutes.post(`${PREFIX}/:requestId/approve`, async (c) => {
  const owner = await requireUser(c); const requestId = c.req.param('requestId');
  if (!requestIdRe.test(requestId)) return unavailable();
  const row = await rowFor(c.env.DB, requestId, Date.now());
  if (!row || row.owner_id !== owner.id || row.status !== 'pending') return unavailable();
  const result = await c.env.DB.prepare(`UPDATE mcp_remote_auth_requests SET status = 'approved_awaiting_machine', approved_at = ?
    WHERE request_id = ? AND owner_id = ? AND status = 'pending' AND expires_at > ?`).bind(Date.now(), requestId, owner.id, Date.now()).run();
  if (!result.meta.changes) return unavailable();
  return c.json({ ...machineStatus({ ...row, status: 'approved_awaiting_machine' }), status_url: `${PREFIX}/${requestId}/status` });
});

for (const action of ['deny', 'cancel'] as const) {
  mcpBrokerRoutes.post(`${PREFIX}/:requestId/${action}`, async (c) => {
    const owner = await requireUser(c); const requestId = c.req.param('requestId');
    if (!requestIdRe.test(requestId)) return unavailable();
    const next = action === 'deny' ? 'denied' : 'cancelled';
    const result = await c.env.DB.prepare(`UPDATE mcp_remote_auth_requests SET status = ?, terminal_at = ?
      WHERE request_id = ? AND owner_id = ? AND status IN ('pending', 'approved_awaiting_machine')`).bind(next, Date.now(), requestId, owner.id).run();
    if (!result.meta.changes) return unavailable();
    return c.json({ protocol_version: MCP_BROKER_VERSION, request_id: requestId, status: next });
  });
}

/** Polling never returns the target metadata or a secret, only the machine's own state. */
mcpBrokerRoutes.post(`${PREFIX}/poll`, async (c) => {
  const result = await machineRow(c);
  if (result instanceof Response) return result;
  return c.json(machineStatus(result.row));
});

/** Atomically redeem a PKCE verifier. Lost responses may replay only the same encrypted result. */
mcpBrokerRoutes.post(`${PREFIX}/redeem`, async (c) => {
  const result = await machineRow(c);
  if (result instanceof Response) return result;
  const { row, body } = result;
  const verifier = body.code_verifier;
  if (typeof verifier !== 'string' || verifier.length < 43 || verifier.length > 128) return invalid();
  if (base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))) !== row.code_challenge) return unavailable();
  if (row.status === 'consumed' && row.result_iv && row.result_ciphertext) {
    const session = await open(row.result_iv, row.result_ciphertext, c.env.SESSION_SIGNING_KEY);
    return session ? c.json({ protocol_version: MCP_BROKER_VERSION, request_id: row.request_id, status: row.status, session }) : unavailable();
  }
  if (row.status !== 'approved_awaiting_machine') return unavailable();
  const user = await c.env.DB.prepare('SELECT login, avatar_url FROM users WHERE id = ?').bind(row.owner_id).first<{ login: string | null; avatar_url: string | null }>();
  const session = await mintSession({ uid: row.owner_id, login: user?.login ?? row.owner_id, avatarUrl: user?.avatar_url ?? null, roles: ['user'] }, c.env.SESSION_SIGNING_KEY);
  const sealed = await seal(session, c.env.SESSION_SIGNING_KEY);
  const won = await c.env.DB.prepare(`UPDATE mcp_remote_auth_requests SET status = 'consumed', consumed_at = ?, result_iv = ?, result_ciphertext = ?
    WHERE request_id = ? AND status = 'approved_awaiting_machine'`).bind(Date.now(), sealed.iv, sealed.ciphertext, row.request_id).run();
  if (!won.meta.changes) return unavailable();
  return c.json({ protocol_version: MCP_BROKER_VERSION, request_id: row.request_id, status: 'consumed', session });
});

/** #356 may mark connected only after a harmless authenticated MCP read succeeds. */
mcpBrokerRoutes.post(`${PREFIX}/connected`, async (c) => {
  const result = await machineRow(c);
  if (result instanceof Response) return result;
  const { row, body } = result;
  const verifier = body.code_verifier;
  if (typeof verifier !== 'string' || base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))) !== row.code_challenge) return unavailable();
  if (row.status === 'connected') return c.json(machineStatus(row));
  const updated = await c.env.DB.prepare(`UPDATE mcp_remote_auth_requests SET status = 'connected', connected_at = ?, terminal_at = ?
    WHERE request_id = ? AND status = 'consumed'`).bind(Date.now(), Date.now(), row.request_id).run();
  if (!updated.meta.changes) return unavailable();
  return c.json({ ...machineStatus({ ...row, status: 'connected' }), retry_after_ms: 0 });
});

/** A companion client records a failed authenticated MCP read without calling it connected. */
mcpBrokerRoutes.post(`${PREFIX}/failed`, async (c) => {
  const result = await machineRow(c);
  if (result instanceof Response) return result;
  const { row, body } = result;
  const verifier = body.code_verifier;
  if (typeof verifier !== 'string' || base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))) !== row.code_challenge) return unavailable();
  if (row.status === 'failed') return c.json(machineStatus(row));
  const updated = await c.env.DB.prepare(`UPDATE mcp_remote_auth_requests SET status = 'failed', terminal_at = ?
    WHERE request_id = ? AND status = 'consumed'`).bind(Date.now(), row.request_id).run();
  if (!updated.meta.changes) return unavailable();
  return c.json({ ...machineStatus({ ...row, status: 'failed' }), retry_after_ms: 0 });
});

// This neutral first-party completion page intentionally has no bearer, code,
// machine proof, owner identity, scope, or target data in its URL or HTML.
mcpBrokerRoutes.get(`${PREFIX}/:requestId/status`, async (c) => {
  const requestId = c.req.param('requestId');
  if (!requestIdRe.test(requestId)) return hostedStatusPage('not_found');
  const row = await rowFor(c.env.DB, requestId, Date.now());
  return hostedStatusPage(row?.status ?? 'not_found');
});
