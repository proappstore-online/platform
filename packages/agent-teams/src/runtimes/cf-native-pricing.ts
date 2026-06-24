/**
 * Cost-meter pricing + estimation for the CFNativeRuntime (Anthropic models).
 */

// Pricing per 1M tokens (approximate, June 2026). Unknown models fall back to
// Sonnet pricing for the cost meter.
export const PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-4-8': { input: 15, output: 75 },
  'claude-opus-4-6': { input: 15, output: 75 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 0.8, output: 4 },
};

export function estimateCost(model: string, tokensIn: number, tokensOut: number): number {
  const pricing = PRICING[model] ?? PRICING['claude-sonnet-4-6']!;
  return (tokensIn * pricing.input + tokensOut * pricing.output) / 1_000_000;
}

// Anthropic prompt-caching multipliers on the base input rate: a cache READ is
// ~0.1× (much cheaper than fresh input), a 5-min cache WRITE is ~1.25×.
const CACHE_READ_MULT = 0.1;
const CACHE_WRITE_MULT = 1.25;

/**
 * Cache-aware cost. `tokensIn` is the TOTAL input (incl. cache), of which
 * `cacheRead` were served from cache and `cacheWrite` created the cache — each
 * billed at a different rate. Charging cached reads at the full input rate (what
 * estimateCost does) materially over-counts cost on the build agents, which
 * cache the system prompt + tools + a rolling message prefix every turn.
 */
export function estimateCostCached(
  model: string,
  tokensIn: number,
  cacheRead: number,
  cacheWrite: number,
  tokensOut: number,
): number {
  const p = PRICING[model] ?? PRICING['claude-sonnet-4-6']!;
  const fresh = Math.max(0, tokensIn - cacheRead - cacheWrite); // uncached input
  const inputCost = fresh * p.input + cacheRead * p.input * CACHE_READ_MULT + cacheWrite * p.input * CACHE_WRITE_MULT;
  return (inputCost + tokensOut * p.output) / 1_000_000;
}
