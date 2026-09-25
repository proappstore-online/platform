declare module 'cloudflare:test' {
  // The union of every project's bindings (each vitest.*.ts config provides its own subset).
  interface ProvidedEnv {
    DB: D1Database;
    STORAGE: R2Bucket;
    APPS: R2Bucket;
    AGENT_STORAGE: R2Bucket;
    ROOM: DurableObjectNamespace;
    PROJECT: DurableObjectNamespace;
    PROVISION_WORKFLOW: Workflow;
    SELF: Fetcher;
    QA_WORKER: Fetcher;
    API: Fetcher;
    ADMIN: Fetcher;
    AGENTS: Fetcher;
    MCP: Fetcher;
    KB: Fetcher;
    PAS_BACKEND: Fetcher;
    TEST_MIGRATIONS: D1Migration[];
    TEST_HOST_MIGRATIONS: D1Migration[];
    SESSION_SIGNING_KEY: string;
    INTERNAL_TOKEN: string;
    APP_SECRET_KEK: string;
    APP_ID: string;
    DATA_WORKER_HOST: string;
  }
}
