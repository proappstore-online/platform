import { describe, expect, it } from 'vitest';
import { addInterval, computeEntitlement, DAY_MS, SUBSCRIPTION_SLACK_MS, type Entitlement, type EntitlementStatus, type PurchaseFacts, type Terms } from './entitlements.js';

// #508: the entitlement rules as a pure function of recorded facts. Times are fixed UTC instants.

const at = (iso: string) => Date.parse(iso);
const TERM: Terms = { intervalUnit: 'month', intervalCount: 3, graceDays: 5 };
const T0 = at('2026-01-10T00:00:00Z');

function purchase(over: Partial<PurchaseFacts> = {}): PurchaseFacts {
  return { id: 'p1', mode: 'one_time', buyerUserId: 'gh:1', createdAt: T0, terms: TERM, payments: [], failedAt: null, refundedAt: null, cancelAtPeriodEnd: false, endedAt: null, ...over };
}
const paid = (id: string, paidAt: number) => ({ id, paidAt });
const sub = (over: Partial<PurchaseFacts> = {}) => purchase({ mode: 'recurring', ...over });
const status = (p: PurchaseFacts[], now: number): EntitlementStatus | null => computeEntitlement(p, now)?.status ?? null;
const end = (p: PurchaseFacts[], now = T0): number | null => computeEntitlement(p, now)?.periodEnd ?? null;

describe('addInterval', () => {
  it('adds days and weeks exactly', () => {
    expect(addInterval(T0, 'day', 10)).toBe(T0 + 10 * DAY_MS);
    expect(addInterval(T0, 'week', 2)).toBe(T0 + 14 * DAY_MS);
  });

  it('adds calendar months and years in UTC, clamping the day', () => {
    expect(addInterval(at('2026-01-10T08:30:00Z'), 'month', 3)).toBe(at('2026-04-10T08:30:00Z'));
    expect(addInterval(at('2026-01-31T00:00:00Z'), 'month', 1)).toBe(at('2026-02-28T00:00:00Z'));
    expect(addInterval(at('2028-01-31T00:00:00Z'), 'month', 1)).toBe(at('2028-02-29T00:00:00Z'));
    expect(addInterval(at('2026-11-15T00:00:00Z'), 'month', 3)).toBe(at('2027-02-15T00:00:00Z'));
    expect(addInterval(at('2024-02-29T00:00:00Z'), 'year', 1)).toBe(at('2025-02-28T00:00:00Z'));
  });

  it('refuses an unknown unit', () => {
    expect(() => addInterval(T0, 'fortnight', 1)).toThrow(/unknown interval unit/);
  });
});

describe('a one-off term', () => {
  const p = [purchase({ payments: [paid('cs:1', T0)] })];

  it('is active for one interval from the payment, then expired at period_end', () => {
    const e = computeEntitlement(p, T0 + DAY_MS)!;
    expect(e).toMatchObject({ status: 'active', periodStart: T0, periodEnd: at('2026-04-10T00:00:00Z'), renews: false, graceUntil: null, buyerUserId: 'gh:1', purchaseId: 'p1' });
    expect(status(p, at('2026-04-09T23:59:59Z'))).toBe('active');
    expect(status(p, at('2026-04-10T00:00:00Z'))).toBe('expired'); // the boundary belongs to the next period
    expect(status(p, at('2027-01-01T00:00:00Z'))).toBe('expired');
  });

  it('has nothing until something is paid', () => {
    expect(computeEntitlement([purchase()], T0)).toBeNull();
    expect(computeEntitlement([], T0)).toBeNull();
  });

  it('with no interval is a lifetime grant: active, with no period_end', () => {
    const e = computeEntitlement([purchase({ terms: { intervalUnit: null, intervalCount: null, graceDays: 0 }, payments: [paid('cs:1', T0)] })], T0 + 3650 * DAY_MS)!;
    expect(e).toMatchObject({ status: 'active', periodEnd: null });
  });

  it('a second term bought while the first is running extends from its period_end, not from the payment date', () => {
    const two = [purchase({ payments: [paid('cs:1', T0)] }), purchase({ id: 'p2', payments: [paid('cs:2', at('2026-02-01T00:00:00Z'))] })];
    expect(end(two)).toBe(at('2026-07-10T00:00:00Z'));
  });

  it('a second term bought after the first lapsed starts at the payment', () => {
    const two = [purchase({ payments: [paid('cs:1', T0)] }), purchase({ id: 'p2', payments: [paid('cs:2', at('2026-06-01T00:00:00Z'))] })];
    expect(computeEntitlement(two, at('2026-06-02T00:00:00Z'))).toMatchObject({ periodStart: at('2026-06-01T00:00:00Z'), periodEnd: at('2026-09-01T00:00:00Z'), status: 'active' });
  });
});

describe('renewal', () => {
  it('extends all three subjects from their previous period_end, not the payment date', () => {
    // The same purchase covers three subjects; each subject's entitlement is computed from the same facts.
    const renewed = sub({ payments: [paid('in:1', T0), paid('in:2', at('2026-04-05T00:00:00Z'))] }); // paid five days early
    for (const _subject of ['kid-a', 'kid-b', 'kid-c']) {
      expect(end([renewed])).toBe(at('2026-07-10T00:00:00Z')); // not 2026-07-05
    }
  });

  it('a late renewal restarts from the payment date', () => {
    const late = sub({ payments: [paid('in:1', T0), paid('in:2', at('2026-04-20T00:00:00Z'))] });
    expect(computeEntitlement([late], at('2026-04-21T00:00:00Z'))).toMatchObject({ periodStart: at('2026-04-20T00:00:00Z'), periodEnd: at('2026-07-20T00:00:00Z') });
  });

  it('a renewing subscription just past period_end stays active awaiting Stripe, for the slack, then expires', () => {
    const s = [sub({ payments: [paid('in:1', T0)] })];
    const periodEnd = at('2026-04-10T00:00:00Z');
    expect(computeEntitlement(s, periodEnd + 1)).toMatchObject({ status: 'active', renews: true });
    expect(status(s, periodEnd + SUBSCRIPTION_SLACK_MS - 1)).toBe('active');
    expect(status(s, periodEnd + SUBSCRIPTION_SLACK_MS)).toBe('expired');
  });
});

describe('payment failure and grace', () => {
  const periodEnd = at('2026-04-10T00:00:00Z');
  const failed = (failedAt: number, graceDays = 5) => [sub({ terms: { ...TERM, graceDays }, payments: [paid('in:1', T0)], failedAt })];

  it('goes to grace until period_end + grace_days, then expired', () => {
    const f = failed(periodEnd + 3600_000);
    const e = computeEntitlement(f, periodEnd + DAY_MS)!;
    expect(e).toMatchObject({ status: 'grace', graceUntil: periodEnd + 5 * DAY_MS, periodEnd });
    expect(status(f, periodEnd + 5 * DAY_MS - 1)).toBe('grace');
    expect(status(f, periodEnd + 5 * DAY_MS)).toBe('expired');
  });

  it('with no grace days expires at period_end', () => {
    expect(status(failed(periodEnd + 1, 0), periodEnd + 1)).toBe('expired');
  });

  it('a failure inside the paid period is grace at once, and the paid time is not shortened', () => {
    const f = failed(at('2026-03-01T00:00:00Z'));
    expect(computeEntitlement(f, at('2026-03-02T00:00:00Z'))).toMatchObject({ status: 'grace', periodEnd, graceUntil: periodEnd + 5 * DAY_MS });
  });

  it('a payment made after the failure resolves it and extends from the old period_end', () => {
    const healed = [sub({ payments: [paid('in:1', T0), paid('in:2', periodEnd + 2 * DAY_MS)], failedAt: periodEnd + 3600_000 })];
    expect(computeEntitlement(healed, periodEnd + 3 * DAY_MS)).toMatchObject({ status: 'active', graceUntil: null, periodStart: periodEnd + 2 * DAY_MS });
  });

  it('a payment made BEFORE the failure does not clear it, however late its event arrived', () => {
    const f = [sub({ payments: [paid('in:1', T0), paid('in:2', periodEnd - DAY_MS)], failedAt: periodEnd + 1000 })];
    expect(status(f, periodEnd + DAY_MS)).toBe('grace');
  });
});

describe('refund', () => {
  it('is refunded at once, with time still on the clock', () => {
    const r = [purchase({ payments: [paid('cs:1', T0)], refundedAt: T0 + DAY_MS })];
    expect(computeEntitlement(r, T0 + 2 * DAY_MS)).toMatchObject({ status: 'refunded', periodEnd: null, renews: false, purchaseId: 'p1' });
  });

  it('is refunded even when the payment event is still to come', () => {
    expect(status([purchase({ refundedAt: T0 })], T0 + DAY_MS)).toBe('refunded');
  });

  it('a refunded purchase buys no time, and a live purchase of the same subject still counts', () => {
    const both = [
      purchase({ id: 'old', payments: [paid('cs:1', T0)], refundedAt: T0 + DAY_MS }),
      purchase({ id: 'new', payments: [paid('cs:2', at('2026-02-01T00:00:00Z'))] }),
    ];
    expect(computeEntitlement(both, at('2026-02-02T00:00:00Z'))).toMatchObject({ status: 'active', periodEnd: at('2026-05-01T00:00:00Z'), purchaseId: 'new' });
  });

  it('a refunded subscription is refunded, not canceled', () => {
    expect(status([sub({ payments: [paid('in:1', T0)], refundedAt: T0 + 1, endedAt: T0 + 2 })], T0 + DAY_MS)).toBe('refunded');
  });
});

describe('cancellation', () => {
  it('cancel-at-period-end stops renewing but keeps the paid period, then expires with no slack', () => {
    const c = [sub({ payments: [paid('in:1', T0)], cancelAtPeriodEnd: true })];
    const periodEnd = at('2026-04-10T00:00:00Z');
    expect(computeEntitlement(c, T0 + DAY_MS)).toMatchObject({ status: 'active', renews: false });
    expect(status(c, periodEnd)).toBe('expired');
  });

  it('an ended subscription is canceled, at once', () => {
    const e = computeEntitlement([sub({ payments: [paid('in:1', T0)], endedAt: T0 + 5 * DAY_MS })], T0 + 6 * DAY_MS)!;
    expect(e).toMatchObject({ status: 'canceled', renews: false, graceUntil: null });
  });

  it('an ended subscription does not cancel an entitlement a live one-off still covers', () => {
    const mixed = [sub({ id: 's', payments: [paid('in:1', T0)], endedAt: T0 + DAY_MS }), purchase({ id: 'o', payments: [paid('cs:1', T0 + 2 * DAY_MS)] })];
    expect(status(mixed, T0 + 3 * DAY_MS)).toBe('active');
  });

  it('a failure on an ended subscription is ignored: it is canceled, not in grace', () => {
    expect(status([sub({ payments: [paid('in:1', T0)], endedAt: T0 + 1, failedAt: T0 + 2 })], T0 + DAY_MS)).toBe('canceled');
  });
});

describe('replay and order never change the answer', () => {
  const facts = (): PurchaseFacts[] => [
    sub({ id: 'a', payments: [paid('in:1', T0), paid('in:2', at('2026-04-10T00:00:00Z')), paid('in:3', at('2026-07-10T00:00:00Z'))] }),
    purchase({ id: 'b', payments: [paid('cs:1', at('2026-02-01T00:00:00Z'))] }),
  ];
  const now = at('2026-08-01T00:00:00Z');
  const baseline = computeEntitlement(facts(), now);

  it('a duplicated payment buys no extra time', () => {
    const dup = facts();
    dup[0]!.payments.push(paid('in:2', at('2026-04-10T00:00:00Z')), paid('in:1', T0));
    dup[1]!.payments.push(paid('cs:1', at('2026-02-01T00:00:00Z')));
    expect(computeEntitlement(dup, now)).toEqual(baseline);
  });

  it('every ordering of the payments and the purchases gives the same entitlement', () => {
    const permutations = <T,>(xs: T[]): T[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest])));
    let tried = 0;
    for (const order of permutations([0, 1])) {
      for (const payOrder of permutations([0, 1, 2])) {
        const f = facts();
        f[0]!.payments = payOrder.map((i) => f[0]!.payments[i]!);
        const shuffled = order.map((i) => f[i]!);
        expect(computeEntitlement(shuffled, now)).toEqual(baseline);
        tried++;
      }
    }
    expect(tried).toBe(12);
  });

  it('the same facts with the failure noted before or after the payments give the same grace', () => {
    const ev = (failedAt: number | null) => [sub({ payments: [paid('in:1', T0), paid('in:2', at('2026-04-10T00:00:00Z'))], failedAt })];
    expect(computeEntitlement(ev(at('2026-07-10T00:00:10Z')), at('2026-07-11T00:00:00Z'))).toMatchObject({ status: 'grace' });
    expect(computeEntitlement(ev(null), at('2026-07-11T00:00:00Z'))).toMatchObject({ status: 'active' });
  });

  it('does not mutate its input', () => {
    const f = facts();
    const copy = JSON.parse(JSON.stringify(f));
    computeEntitlement(f, now);
    expect(f).toEqual(copy);
  });

  it('is deterministic for a given clock', () => {
    const a: Entitlement | null = computeEntitlement(facts(), now);
    expect(computeEntitlement(facts(), now)).toEqual(a);
  });
});

describe('who and which purchase', () => {
  it('names the buyer and purchase of the latest payment', () => {
    const f = [purchase({ id: 'first', buyerUserId: 'gh:1', payments: [paid('cs:1', T0)] }), purchase({ id: 'second', buyerUserId: 'gh:2', payments: [paid('cs:2', T0 + DAY_MS)] })];
    expect(computeEntitlement(f, T0 + 2 * DAY_MS)).toMatchObject({ buyerUserId: 'gh:2', purchaseId: 'second' });
  });
});
