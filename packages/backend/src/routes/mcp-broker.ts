/**
 * Remote MCP approval broker (#355).
 *
 * This endpoint is intentionally fail-closed. The first implementation
 * returned a PAS session JWT from the API worker. A session JWT is accepted
 * by every MCP resource, whereas the MCP worker's opaque OAuth tokens are
 * the sole credentials that are resource-bound and enforced at dispatch.
 *
 * Do not turn this on until the API worker can ask the MCP worker to issue a
 * resource-bound opaque token over an authenticated service binding, and the
 * browser approval flow is bound to a real hosted PAS sign-in/callback. An
 * existing PAGS bearer is not a bootstrap for first login or expired sessions.
 */
import { Hono } from 'hono';
import type { Env } from '../types.js';

export const mcpBrokerRoutes = new Hono<{ Bindings: Env }>();

/** Kept so prospective clients can identify the withdrawn protocol revision. */
export const MCP_BROKER_VERSION = '2026-10-10';
const PREFIX = '/mcp/broker/v1';

// Match every method and nested path. Keeping the route mounted means an
// accidentally cached or guessed URL is refused explicitly, not mistaken for
// an unrelated API 404. No request body is parsed or logged, so proofs, PKCE
// verifiers and bearer tokens cannot escape through an error response.
function unavailable(c: any) {
  return c.json({
  error: 'remote_auth_unavailable',
  error_description: 'Remote MCP approval is disabled pending resource-bound OAuth issuance and hosted approval binding.',
  protocol_version: MCP_BROKER_VERSION,
}, 503, {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  });
}

mcpBrokerRoutes.all(PREFIX, unavailable);
mcpBrokerRoutes.all(`${PREFIX}/*`, unavailable);
