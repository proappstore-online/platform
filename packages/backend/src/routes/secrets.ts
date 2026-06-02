/**
 * Proxy, secrets, and allowlist routes — vendored from FAS.
 * PAS owns this copy. Auth uses PAS's requireUser/requireAppOwner
 * (checks creator_id, not owner_login). No user key vault fallback
 * (Pro apps use app.ai directly for AI providers).
 */
import { Hono } from 'hono';
import type { Env } from '../types.js';
import { registerAllowlistCrudRoutes } from './secrets-allowlist-crud.js';
import { registerSecretsCrudRoutes } from './secrets-crud.js';
import { registerProxyRoute } from './secrets-proxy.js';

export const secretsRoutes = new Hono<{ Bindings: Env }>();

// -----------------------------------------------------------------------------
// Secrets CRUD
// -----------------------------------------------------------------------------
registerSecretsCrudRoutes(secretsRoutes);

// -----------------------------------------------------------------------------
// Allowlist CRUD
// -----------------------------------------------------------------------------
registerAllowlistCrudRoutes(secretsRoutes);

// -----------------------------------------------------------------------------
// The proxy itself
// -----------------------------------------------------------------------------
registerProxyRoute(secretsRoutes);
