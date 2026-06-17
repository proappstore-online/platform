/**
 * Cloudflare AI Gateway routing for the agent runtimes.
 *
 * When AI_GATEWAY_ACCOUNT_ID + AI_GATEWAY_ID are configured, provider calls go
 * through the gateway instead of straight to the provider's public API. The
 * owner's BYO key passes through unchanged and Anthropic prompt-caching is
 * preserved — the gateway only adds caching, rate-limiting, fallback, and
 * per-request token/cost observability. Routing is fully opt-in per environment:
 * with the vars unset, every call falls back to the provider's direct API, so
 * shipping this code changes nothing until the gateway is wired up.
 *
 * Set up (one-time, per account):
 *   1. Dashboard → AI → AI Gateway → create a gateway (note its id).
 *   2. wrangler.toml [vars]: AI_GATEWAY_ACCOUNT_ID, AI_GATEWAY_ID.
 *   3. (optional) authenticated gateway: `wrangler secret put AI_GATEWAY_TOKEN`.
 */

export type GatewayProvider = 'anthropic' | 'openai';

/** Subset of the Worker env this module reads. Structurally a subset of Bindings. */
export type GatewayEnv = {
  AI_GATEWAY_ACCOUNT_ID?: string | undefined;
  AI_GATEWAY_ID?: string | undefined;
  AI_GATEWAY_TOKEN?: string | undefined;
};

/** True when AI Gateway routing is active for this environment. */
export function gatewayEnabled(env: GatewayEnv): boolean {
  return Boolean(env.AI_GATEWAY_ACCOUNT_ID && env.AI_GATEWAY_ID);
}

/**
 * Base URL for a model provider. Callers append the provider's endpoint path:
 *   anthropic → `${base}/v1/messages`
 *   openai    → `${base}/responses`
 * Both the gateway and direct forms share these suffixes, so the caller's
 * URL construction is identical regardless of routing.
 */
export function providerBaseUrl(env: GatewayEnv, provider: GatewayProvider): string {
  if (gatewayEnabled(env)) {
    return `https://gateway.ai.cloudflare.com/v1/${env.AI_GATEWAY_ACCOUNT_ID}/${env.AI_GATEWAY_ID}/${provider}`;
  }
  return provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1';
}

/**
 * Extra request headers for AI Gateway. An "authenticated gateway" rejects
 * requests without `cf-aig-authorization`; set AI_GATEWAY_TOKEN to supply it.
 * Returns {} when unset (unauthenticated gateway or direct provider call).
 */
export function gatewayHeaders(env: GatewayEnv): Record<string, string> {
  return env.AI_GATEWAY_TOKEN ? { 'cf-aig-authorization': `Bearer ${env.AI_GATEWAY_TOKEN}` } : {};
}

/** Resolved gateway routing for one provider, threaded through PrepareContext. */
export type GatewayConfig = {
  baseUrl: string;
  headers: Record<string, string>;
};

/** Build the per-provider routing config from the Worker env. */
export function resolveGateway(env: GatewayEnv, provider: GatewayProvider): GatewayConfig {
  return { baseUrl: providerBaseUrl(env, provider), headers: gatewayHeaders(env) };
}
