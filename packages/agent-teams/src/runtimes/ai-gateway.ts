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
  /** '1' = never fall back to the provider's direct API when the gateway is
   *  unreachable (every call must be observable at the gateway). Default: fall back. */
  AI_GATEWAY_STRICT?: string | undefined;
};

/** The provider's public API — where a call goes when the gateway is off or down. */
export function directBaseUrl(provider: GatewayProvider): string {
  return provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1';
}

/** Fallback to the direct API is on unless the operator opted into strict routing. */
export function gatewayFallbackAllowed(env: GatewayEnv): boolean {
  return env.AI_GATEWAY_STRICT !== '1' && env.AI_GATEWAY_STRICT !== 'true';
}

/**
 * A failure that means "the gateway did not relay the request", as opposed to
 * a provider answer relayed by the gateway: a network error (null), or an
 * edge status — 502/503/504 and Cloudflare's 52x family. A provider 4xx, or a
 * 500 the provider itself returned, is NOT an outage and is never retried
 * elsewhere: the answer is the answer.
 */
export function isGatewayOutage(status: number | null): boolean {
  return status === null || status === 502 || status === 503 || status === 504 || (status >= 520 && status <= 530);
}

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
  return directBaseUrl(provider);
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
  /** Where to retry when `baseUrl` is the gateway and it is unreachable; null
   *  when already direct or when AI_GATEWAY_STRICT forbids the fallback. The
   *  gateway headers are never sent to the fallback target. */
  fallbackBaseUrl: string | null;
};

/** Build the per-provider routing config from the Worker env. */
export function resolveGateway(env: GatewayEnv, provider: GatewayProvider): GatewayConfig {
  const viaGateway = gatewayEnabled(env);
  return {
    baseUrl: providerBaseUrl(env, provider),
    headers: gatewayHeaders(env),
    fallbackBaseUrl: viaGateway && gatewayFallbackAllowed(env) ? directBaseUrl(provider) : null,
  };
}

// ── Shared Anthropic call for the chat agents (PO / Architect / QA / listing) ──
//
// The build runtimes (cf-native.ts, openai-responses.ts) carry their own retry
// loop; the four chat-style Anthropic calls used to each build a direct fetch.
// One helper keeps every LLM call on the same routing, the same auth-header
// rule (the gateway token goes to the gateway only, the BYO key goes to both)
// and the same fallback.

export interface AnthropicCall {
  apiKey: string;
  body: unknown;
  signal?: AbortSignal | undefined;
  /** e.g. an `anthropic-beta` header. Never auth. */
  extraHeaders?: Record<string, string> | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export type AnthropicRoute = 'direct' | 'gateway' | 'gateway-fallback';

/** The request headers for one Anthropic call on one route. */
export function anthropicHeaders(env: GatewayEnv, apiKey: string, route: AnthropicRoute, extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...(route === 'gateway' ? gatewayHeaders(env) : {}),
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'Content-Type': 'application/json',
    ...extra,
  };
}

/**
 * POST /v1/messages through the configured routing. Returns the response and
 * the route that produced it. When the gateway does not relay the request
 * (`isGatewayOutage`) and fallback is allowed, the call is retried once against
 * the provider directly, without the gateway token. The BYO key is never logged.
 */
export async function fetchAnthropicMessages(env: GatewayEnv, call: AnthropicCall): Promise<{ res: Response; route: AnthropicRoute }> {
  const fetchImpl = call.fetchImpl ?? fetch;
  const cfg = resolveGateway(env, 'anthropic');
  const route: AnthropicRoute = gatewayEnabled(env) ? 'gateway' : 'direct';
  const init = (r: AnthropicRoute): RequestInit => ({
    method: 'POST',
    headers: anthropicHeaders(env, call.apiKey, r, call.extraHeaders),
    body: JSON.stringify(call.body),
    signal: call.signal ?? null,
  });
  let status: number | null;
  try {
    const res = await fetchImpl(`${cfg.baseUrl}/v1/messages`, init(route));
    if (route !== 'gateway' || !isGatewayOutage(res.status)) return { res, route };
    status = res.status;
  } catch (e) {
    if (route !== 'gateway' || call.signal?.aborted) throw e;
    status = null;
  }
  if (!cfg.fallbackBaseUrl) {
    // Strict routing: surface the outage as the response the caller would have seen.
    return { res: new Response(JSON.stringify({ error: { message: `AI Gateway unreachable (${status ?? 'network error'}); strict routing forbids the direct fallback` } }), { status: status ?? 503, headers: { 'Content-Type': 'application/json' } }), route };
  }
  console.warn(`[ai-gateway] gateway unreachable (${status ?? 'network error'}); retrying Anthropic directly`);
  const res = await fetchImpl(`${cfg.fallbackBaseUrl}/v1/messages`, init('gateway-fallback'));
  return { res, route: 'gateway-fallback' };
}
