export interface Env {
  /** R2 bucket: published app files at apps/{slug}/* */
  APPS: R2Bucket;
  /** D1: routes table maps subdomain → r2_prefix */
  DB: D1Database;
  /** Service binding: api.proappstore.online → proappstore-api */
  API: Fetcher;
  /** Service binding: admin.proappstore.online → proappstore-admin */
  ADMIN: Fetcher;
  /** Service binding: agents.proappstore.online → proappstore-agent-teams */
  AGENTS: Fetcher;
  /** Service binding: mcp.proappstore.online → proappstore-mcp */
  MCP: Fetcher;
  /** Service binding: kb.proappstore.online and docs.proappstore.online -> proappstore-kb-host */
  KB: Fetcher;
  /** workers.dev host of the per-app data workers (`pas-data-<app>.<host>`),
   *  e.g. `serge-the-dev.workers.dev` — where `data-<app>.proappstore.online`
   *  is proxied to (#153). Configuration, not a literal in source. */
  DATA_WORKER_HOST: string;
}
