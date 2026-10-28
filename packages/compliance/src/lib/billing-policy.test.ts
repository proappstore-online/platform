import { describe, expect, it } from 'vitest';
import { validateBilling } from './billing-policy.js';

const action = { name: 'can_buy', operation: 'query', callers: ['billing'], requires_auth: true, params: { product: { type: 'string' }, subjects_json: { type: 'string' } } };
const product = { key: 'child_term', name: 'Term', amount: 1000, currency: 'AUD', tax_behavior: 'inclusive', modes: ['one_time', 'recurring'], interval: { unit: 'month', count: 3 }, grace_days: 5, subject: 'required' };
const ok = (over: Record<string, unknown> = {}, tool: Record<string, unknown> = {}) =>
  validateBilling({ authorize_action: 'can_buy', products: [{ ...product, ...over }] }, [{ ...action, ...tool }]);

describe('validateBilling (#507)', () => {
  it('absent or null means the app sells nothing', () => {
    expect(validateBilling(undefined, [])).toEqual({ billing: null });
    expect(validateBilling(null, [])).toEqual({ billing: null });
  });

  it('accepts the #506 shape and normalises the currency', () => {
    const r = ok();
    expect(r).toEqual({ billing: { authorize_action: 'can_buy', products: [{ ...product, currency: 'aud' }] } });
  });

  it('applies defaults: one_time, no tax statement, no grace, no subject', () => {
    const r = validateBilling({ authorize_action: 'can_buy', products: [{ key: 'pass', name: 'Pass', amount: 500, currency: 'usd' }] }, [action]);
    expect(r).toEqual({ billing: { authorize_action: 'can_buy', products: [{ key: 'pass', name: 'Pass', amount: 500, currency: 'usd', tax_behavior: 'unspecified', modes: ['one_time'], interval: null, grace_days: 0, subject: 'none' }] } });
  });

  it.each([
    ['a non-object', 'x', 'billing must be an object'],
    ['an unknown top-level field', { authorize_action: 'can_buy', products: [product], extra: 1 }, 'unknown field "extra"'],
    ['no products', { authorize_action: 'can_buy', products: [] }, 'billing.products'],
    ['no authorize_action', { products: [product] }, 'authorize_action must name'],
  ])('refuses %s', (_l, raw, fragment) => {
    const r = validateBilling(raw, [action]);
    expect('error' in r && r.error).toContain(fragment);
  });

  it.each([
    ['a float amount', { amount: 10.5 }, 'amount'],
    ['a zero amount', { amount: 0 }, 'amount'],
    ['a bad currency', { currency: 'dollars' }, 'currency'],
    ['a bad key', { key: 'Has Space' }, 'key'],
    ['an unknown field', { price_cents: 5 }, 'unknown field'],
    ['an unknown tax behaviour', { tax_behavior: 'maybe' }, 'tax_behavior'],
    ['the Stripe mode names instead of one_time/recurring', { modes: ['payment'] }, 'modes'],
    ['repeated modes', { modes: ['one_time', 'one_time'] }, 'modes'],
    ['recurring without an interval', { interval: undefined }, 'interval is required'],
    ['an interval count above Stripe\'s limit', { interval: { unit: 'year', count: 2 } }, 'interval.count'],
    ['an unknown interval unit', { interval: { unit: 'decade', count: 1 } }, 'interval.unit'],
    ['grace beyond 30 days', { grace_days: 31 }, 'grace_days'],
    ['an unknown subject mode', { subject: 'optional' }, 'subject'],
  ])('refuses %s', (_l, over, fragment) => {
    const r = ok(over);
    expect('error' in r && r.error).toContain(fragment);
  });

  it('refuses duplicate product keys', () => {
    const r = validateBilling({ authorize_action: 'can_buy', products: [product, product] }, [action]);
    expect('error' in r && r.error).toContain('duplicate key');
  });

  it.each([
    ['is not in the manifest', { name: 'other' }, 'is not an action'],
    ['is not a query', { operation: 'execute' }, 'query action'],
    ['lacks the billing caller', { callers: ['user'] }, 'must list "billing"'],
    ['also lists worker', { callers: ['billing', 'worker'] }, 'must not also list'],
    ['is public', { requires_auth: false }, 'must require auth'],
    ['is scheduled', { schedule: { cron: '* * * * *', params: {} } }, 'scheduled'],
    ['is role-gated', { auth: { app_roles: ['admin'] } }, 'role-gated'],
    ['lacks the product param', { params: { subjects_json: { type: 'string' } } }, '"product"'],
    ['lacks the subjects_json param', { params: { product: { type: 'string' } } }, '"subjects_json"'],
  ])('refuses an authorize action that %s', (_l, tool, fragment) => {
    const r = ok({}, tool);
    expect('error' in r && r.error).toContain(fragment);
  });
});
