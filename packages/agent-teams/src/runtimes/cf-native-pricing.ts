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
