/**
 * Cost-meter pricing + estimation for the CFNativeRuntime (Anthropic models).
 */

import { ANTHROPIC_PRICING as PRICING } from './pricing.ts';

// Prices come from the shared table in pricing.ts. Unknown models fall back to
// Sonnet pricing for the cost meter.

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
