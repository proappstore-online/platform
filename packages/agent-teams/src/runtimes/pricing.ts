/**
 * Provider price tables for the cost meter (#22).
 *
 * These are hand-maintained and go stale on every provider reprice. They are
 * NOT the source of truth for money: AI Gateway records tokens and cost per
 * request (dashboard → AI → AI Gateway → pas-agent-teams → Logs / Analytics),
 * and docs/ai-gateway.md describes the monthly cross-check of `cost_ledger`
 * against it. What the tables give the platform is a live, per-turn estimate
 * for the cost cap and the UI, which must (a) cover every model the platform
 * configures by default, and (b) never silently price an unknown model as if
 * it were known — hence `PRICED_MODELS`, the coverage test, and the one-time
 * warning below.
 */

export interface ModelPrice { input: number; output: number }

/** When the tables were last checked against the providers' price pages (YYYY-MM). */
export const PRICING_VERIFIED_AT = '2026-06';

/** USD per 1M tokens. */
export const ANTHROPIC_PRICING: Record<string, ModelPrice> = {
  'claude-opus-4-8': { input: 15, output: 75 },
  'claude-opus-4-6': { input: 15, output: 75 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 0.8, output: 4 },
};

export const OPENAI_PRICING: Record<string, ModelPrice> = {
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'o3-mini': { input: 1.1, output: 4.4 },
};

export type PriceProvider = 'anthropic' | 'openai';
const FALLBACK: Record<PriceProvider, string> = { anthropic: 'claude-sonnet-4-6', openai: 'gpt-4o' };

export function isPricedModel(provider: PriceProvider, model: string): boolean {
  return Object.hasOwn(provider === 'anthropic' ? ANTHROPIC_PRICING : OPENAI_PRICING, model);
}

const warned = new Set<string>();
/**
 * The price for a model, or the provider's fallback price for an unknown one
 * — warned once per model per isolate, so a new default model that never made
 * it into the table shows up in the Worker logs instead of silently metering
 * at the wrong rate.
 */
export function priceFor(provider: PriceProvider, model: string): { price: ModelPrice; source: 'table' | 'fallback' } {
  const table = provider === 'anthropic' ? ANTHROPIC_PRICING : OPENAI_PRICING;
  const price = table[model];
  if (price) return { price, source: 'table' };
  if (!warned.has(model)) {
    warned.add(model);
    console.warn(`[pricing] no price for ${provider} model "${model}" (tables verified ${PRICING_VERIFIED_AT}); metering at ${FALLBACK[provider]} rates — add it to runtimes/pricing.ts and cross-check AI Gateway analytics`);
  }
  return { price: table[FALLBACK[provider]]!, source: 'fallback' };
}

/** Test seam: forget which models were already warned about. */
export function resetPricingWarnings(): void { warned.clear(); }
