/**
 * Worker bindings — type-safe wrapper around what wrangler.toml declares.
 *
 * v0.1: minimal. Stage 0 (~week 3) wires:
 *   - APPS_R2 (R2 bucket, shared with pas/admin)
 *   - ADMIN service binding (admin.proappstore.online dispatch)
 *   - API service binding (api.proappstore.online dispatch)
 *   - DB (D1 routes table for subdomain → r2_prefix lookup)
 *
 * Patterns inherited from fas/host/src/env.ts.
 */
export type Env = {
  // bindings (to be wired in stage 0)
  // APPS_R2: R2Bucket;
  // ADMIN: Fetcher;
  // API: Fetcher;
  // DB: D1Database;
};
