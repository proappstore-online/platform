import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANTHROPIC_PRICING, OPENAI_PRICING, PRICING_VERIFIED_AT, isPricedModel, priceFor, resetPricingWarnings } from './pricing.ts';
import { ARCHITECT_MODEL } from '../architect-chat.ts';
import { PO_MODEL } from '../po-chat.ts';
import { QA_MODEL } from '../qa-chat.ts';
import { LISTING_MODEL } from '../project-do.ts';
import { estimateCost, estimateCostCached } from './cf-native-pricing.ts';

afterEach(() => { resetPricingWarnings(); vi.restoreAllMocks(); });

/** #22: the hand-maintained tables must cover what the platform actually runs, and never price an unknown model silently. */
describe('pricing tables', () => {
  it('every model the platform configures by default is priced', () => {
    for (const m of ['claude-sonnet-4-6', ARCHITECT_MODEL, PO_MODEL, QA_MODEL, LISTING_MODEL]) expect(isPricedModel('anthropic', m), m).toBe(true);
    expect(Object.keys(OPENAI_PRICING).length).toBeGreaterThan(0);
    expect(PRICING_VERIFIED_AT).toMatch(/^\d{4}-\d{2}$/);
    for (const t of [ANTHROPIC_PRICING, OPENAI_PRICING]) for (const [m, p] of Object.entries(t)) { expect(p.input, m).toBeGreaterThan(0); expect(p.output, m).toBeGreaterThan(p.input); }
  });

  it('an unknown model meters at the provider fallback rate and warns exactly once per model', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(priceFor('anthropic', 'claude-next-1')).toEqual({ price: ANTHROPIC_PRICING['claude-sonnet-4-6'], source: 'fallback' });
    expect(priceFor('anthropic', 'claude-next-1').source).toBe('fallback');
    expect(priceFor('openai', 'gpt-99').source).toBe('fallback');
    expect(priceFor('anthropic', 'claude-haiku-4-5')).toEqual({ price: ANTHROPIC_PRICING['claude-haiku-4-5'], source: 'table' });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0]![0])).toContain('no price for anthropic model "claude-next-1"');
    expect(String(warn.mock.calls[0]![0])).toContain(PRICING_VERIFIED_AT);
    expect(String(warn.mock.calls[0]![0])).not.toMatch(/sk-/);
  });

  it('the Anthropic estimators read the shared table', () => {
    expect(estimateCost('claude-haiku-4-5', 1_000_000, 0)).toBeCloseTo(0.8);
    expect(estimateCostCached('claude-sonnet-4-6', 1_000_000, 0, 0, 0)).toBeCloseTo(3);
  });
});
