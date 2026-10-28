import { describe, expect, it } from 'vitest';
import type { ToolManifest } from '../action-sql.js';
import { MAX_BILLING_PRODUCTS, validateBilling } from './billing.js';

const authorize = (over: Record<string, unknown> = {}): ToolManifest => ({
  name: 'may_buy', description: 'May buy', operation: 'query', requires_auth: true, callers: ['billing'],
  params: { product: { type: 'string' }, subjects_json: { type: 'string' } },
  sql: 'SELECT 1 AS allowed FROM members WHERE user_id = :__user_id AND :product IS NOT NULL',
  ...over,
}) as ToolManifest;
const product = (over: Record<string, unknown> = {}) => ({ key: 'child_term', name: 'Term', amount: 1000, currency: 'aud', ...over });
const ok = (raw: unknown, tools: ToolManifest[] = [authorize()]) => validateBilling(raw, tools);
const err = (raw: unknown, tools: ToolManifest[] = [authorize()]): string => {
  const r = ok(raw, tools);
  expect('error' in r, JSON.stringify(raw)).toBe(true);
  return (r as { error: string }).error;
};
const decl = (p: Record<string, unknown> = product(), extra: Record<string, unknown> = {}) => ({ authorize_action: 'may_buy', products: [p], ...extra });

describe('billing manifest (#507)', () => {
  it('an absent section sells nothing', () => {
    expect(ok(undefined)).toEqual({ billing: null });
    expect(ok(null)).toEqual({ billing: null });
  });

  it('accepts the Chess Clubs term product and fills the defaults', () => {
    const r = ok(decl(product({ tax_behavior: 'inclusive', modes: ['one_time', 'recurring'], interval: { unit: 'month', count: 3 }, grace_days: 5, subject: 'required' })));
    expect(r).toEqual({ billing: { authorize_action: 'may_buy', products: [{
      key: 'child_term', name: 'Term', amount: 1000, currency: 'aud', tax_behavior: 'inclusive', modes: ['one_time', 'recurring'], interval: { unit: 'month', count: 3 }, grace_days: 5, subject: 'required',
    }] } });
    expect(ok(decl())).toMatchObject({ billing: { products: [{ tax_behavior: 'unspecified', modes: ['one_time'], interval: null, grace_days: 0, subject: 'none' }] } });
  });

  it('refuses unknown fields, and an empty, oversized or repeating product list', () => {
    expect(err({ ...decl(), extra: 1 })).toMatch(/unknown field "extra"/);
    expect(err(decl(product({ colour: 'red' })))).toMatch(/unknown field "colour"/);
    expect(err({ authorize_action: 'may_buy', products: [] })).toMatch(/non-empty list/);
    expect(err({ authorize_action: 'may_buy', products: Array.from({ length: MAX_BILLING_PRODUCTS + 1 }, (_, i) => product({ key: `p${i}` })) })).toMatch(/max 20/);
    expect(err({ authorize_action: 'may_buy', products: [product(), product()] })).toMatch(/declared twice/);
    expect(err('yes')).toMatch(/must be an object/);
  });

  it('checks a product: key, name, amount, currency, tax behaviour, modes', () => {
    for (const key of ['', 'Child', '1term', 'child-term', 'x'.repeat(41)]) expect(err(decl(product({ key }))), key).toMatch(/key must be/);
    expect(err(decl(product({ name: '  ' })))).toMatch(/name is required/);
    expect(err(decl(product({ name: 'n'.repeat(101) })))).toMatch(/name is required/);
    for (const amount of [0, -5, 10.5, '1000', 100_000_000, null]) expect(err(decl(product({ amount }))), String(amount)).toMatch(/amount must be a whole number/);
    for (const currency of ['AUD', 'aus', 'xyz', undefined, 5]) expect(err(decl(product({ currency }))), String(currency)).toMatch(/currency must be one of/);
    expect(err(decl(product({ tax_behavior: 'included' })))).toMatch(/tax_behavior must be/);
    for (const modes of [[], ['monthly'], ['one_time', 'one_time'], 'one_time']) expect(err(decl(product({ modes }))), JSON.stringify(modes)).toMatch(/modes must be/);
  });

  it("checks the interval: required to recur, Stripe's one-year ceiling, and nothing extra", () => {
    expect(err(decl(product({ modes: ['recurring'] })))).toMatch(/recurring product needs an interval/);
    for (const interval of [{ unit: 'month' }, { unit: 'decade', count: 1 }, { unit: 'month', count: 0 }, { unit: 'month', count: 1.5 }, 'monthly']) {
      expect(err(decl(product({ modes: ['recurring'], interval }))), JSON.stringify(interval)).toMatch(/interval must be/);
    }
    expect(err(decl(product({ modes: ['recurring'], interval: { unit: 'month', count: 13 } })))).toMatch(/at most 12/);
    expect(err(decl(product({ modes: ['recurring'], interval: { unit: 'year', count: 2 } })))).toMatch(/at most 1/);
    expect(err(decl(product({ modes: ['recurring'], interval: { unit: 'month', count: 1, extra: 1 } })))).toMatch(/only unit and count/);
    for (const interval of [{ unit: 'day', count: 365 }, { unit: 'week', count: 52 }, { unit: 'month', count: 12 }, { unit: 'year', count: 1 }]) {
      expect(ok(decl(product({ modes: ['recurring'], interval })))).toHaveProperty('billing.products.0.interval', interval);
    }
    // a one-off product may name its period (the entitlement length, #508) without recurring
    expect(ok(decl(product({ interval: { unit: 'month', count: 3 } })))).toHaveProperty('billing.products.0.interval.count', 3);
  });

  it('checks grace_days and subject', () => {
    for (const grace_days of [-1, 31, 1.5, '5']) expect(err(decl(product({ grace_days }))), String(grace_days)).toMatch(/grace_days must be/);
    for (const subject of ['optional', true, 'Required']) expect(err(decl(product({ subject }))), String(subject)).toMatch(/subject must be/);
    expect(ok(decl(product({ grace_days: 30 })))).toHaveProperty('billing.products.0.grace_days', 30);
  });

  it('fails closed: every product needs an authorize action, and it must be safe', () => {
    expect(err({ products: [product()] })).toMatch(/authorize_action is required/);
    expect(err(decl(product(), { authorize_action: '' }))).toMatch(/authorize_action is required/);
    expect(err(decl(), [])).toMatch(/not a tool in this manifest/);
    expect(err(decl(), [authorize({ callers: ['user'] })])).toMatch(/callers: \["billing"\] only/);
    expect(err(decl(), [authorize({ callers: ['user', 'billing'] })])).toMatch(/callers: \["billing"\] only/);
    expect(err(decl(), [authorize({ callers: undefined })])).toMatch(/callers: \["billing"\] only/);
    expect(err(decl(), [authorize({ operation: 'execute', sql: 'INSERT INTO t (a) VALUES (:__user_id)' })])).toMatch(/must be a query/);
    expect(err(decl(), [authorize({ requires_auth: false })])).toMatch(/must require auth/);
    expect(err(decl(), [authorize({ sql: 'SELECT 1 AS allowed' })])).toMatch(/must use :__user_id/);
    expect(err(decl(), [authorize({ sql: 'SELECT 1 AS ok WHERE :__user_id IS NOT NULL' })])).toMatch(/"allowed" column/);
  });

  it('lets the authorize action take only the two params the checkout supplies, as strings', () => {
    expect(err(decl(), [authorize({ params: { child: { type: 'string' } } })])).toMatch(/only the string params/);
    expect(err(decl(), [authorize({ params: { product: { type: 'integer' } } })])).toMatch(/only the string params/);
    expect(ok(decl(), [authorize({ params: {} })])).toHaveProperty('billing.authorize_action', 'may_buy');
    expect(ok(decl(), [authorize({ sql: 'SELECT allowed FROM t WHERE u = :__user_id', params: {} })])).toHaveProperty('billing.authorize_action', 'may_buy');
  });
});
