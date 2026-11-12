/**
 * Proxy, secrets, and allowlist routes — vendored from FAS.
 * PAS owns this copy. Auth uses PAS's requireUser/requireAppOwner
 * (checks creator_id, not owner_login). No platform-wide user key vault;
 * a user's own key is per app (#587, secrets-user.ts), and a rule that
 * injects it never falls back to the app secret.
 */
import { Hono } from 'hono';
import type { Env } from '../types.js';
import { registerAllowlistCrudRoutes } from './secrets-allowlist-crud.js';
import { registerSecretsCrudRoutes } from './secrets-crud.js';
import { registerProxyRoute } from './secrets-proxy.js';
import { registerUserSecretsRoutes } from './secrets-user.js';

export const secretsRoutes = new Hono<{ Bindings: Env }>();

// -----------------------------------------------------------------------------
// Secrets CRUD
// -----------------------------------------------------------------------------
registerSecretsCrudRoutes(secretsRoutes);

// -----------------------------------------------------------------------------
// Per-user secrets (#587)
// -----------------------------------------------------------------------------
registerUserSecretsRoutes(secretsRoutes);

// -----------------------------------------------------------------------------
// Allowlist CRUD
// -----------------------------------------------------------------------------
registerAllowlistCrudRoutes(secretsRoutes);

// -----------------------------------------------------------------------------
// The proxy itself
// -----------------------------------------------------------------------------
registerProxyRoute(secretsRoutes);
