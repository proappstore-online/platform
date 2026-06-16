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
  /** Service binding: build.proappstore.online → proappstore-build-orchestrator (GitHub App webhook → build queue) */
  BUILD: Fetcher;
}
