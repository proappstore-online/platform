/**
 * Worker environment bindings, in their own module so feature modules import the
 * type from HERE rather than from index.ts. index.ts imports those modules to
 * wire routes, so importing `Bindings` back from index.ts created import cycles
 * (index → project-do → architect-chat → index, etc.). Types-only, so the cycle
 * was harmless at runtime — but breaking it keeps the dependency graph acyclic.
 */
export type Bindings = {
  PROJECT: DurableObjectNamespace;
  AGENT_STORAGE: R2Bucket;
  /** Shared PAS D1 — the agent_projects index (list a user's projects). */
  DB: D1Database;
  PAS_BACKEND: Fetcher;
  /** Service binding to the PAS admin Worker — for the agent deploy flow
   *  (repo create + file push + registry). */
  ADMIN?: Fetcher;
  /** Service binding to the KB host Worker (kb.proappstore.online is a route,
   *  and same-zone subrequests bypass route-mapped Workers). Optional so local
   *  dev without the binding degrades to skipping test-result harvest. */
  KB?: Fetcher;
  SESSION_SIGNING_KEY: string;
  PAS_API_BASE: string;
  /**
   * Shared secret for authenticating internal calls to the PAS backend
   * (e.g. GET /v1/keys/resolve/:provider). Mirrors INTERNAL_TOKEN on the
   * backend Worker. Set via `wrangler secret put INTERNAL_TOKEN`.
   */
  INTERNAL_TOKEN?: string;
  /**
   * Cloudflare AI Gateway routing (opt-in). When both are set, agent provider
   * calls go through the gateway for caching, fallback, and token/cost
   * observability; BYO keys + Anthropic prompt-caching pass through unchanged.
   * Unset → calls go direct to the provider. See runtimes/ai-gateway.ts.
   */
  AI_GATEWAY_ACCOUNT_ID?: string;
  AI_GATEWAY_ID?: string;
  /** Optional — only for an authenticated gateway. `wrangler secret put AI_GATEWAY_TOKEN`. */
  AI_GATEWAY_TOKEN?: string;
  /**
   * Canary: route these projects' deploys through the durable provisioning
   * Workflow (admin /api/provision-workflow/agent) instead of the inline
   * push + poll. Comma-separated app slugs, or '*' for all. Unset → every deploy
   * uses the inline path (default). See deploy-stage.ts. Refs #24.
   */
  WORKFLOW_DEPLOY_SLUGS?: string;
  /**
   * Workers AI + Vectorize for KB RAG (kb-rag.ts). The living KB is chunked +
   * embedded into VECTORIZE (per-project, isolated by slug) on write; build
   * agents retrieve only the relevant chunks per ticket. Optional — with either
   * unset, grounding falls back to whole-file KNOWLEDGE.md injection.
   */
  AI?: import('@cloudflare/workers-types').Ai;
  VECTORIZE?: import('@cloudflare/workers-types').VectorizeIndex;
};
