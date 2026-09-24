declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database;
    STORAGE: R2Bucket;
    ROOM: DurableObjectNamespace;
    SELF: Fetcher;
    QA_WORKER: Fetcher;
    API: Fetcher;
    TEST_MIGRATIONS: D1Migration[];
    SESSION_SIGNING_KEY: string;
    INTERNAL_TOKEN: string;
    APP_ID: string;
    DATA_WORKER_HOST: string;
  }
}
