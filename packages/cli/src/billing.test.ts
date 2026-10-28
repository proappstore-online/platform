import { describe, expect, it } from 'vitest';
import { billingCommand, formatEntitlements, formatProducts, formatPurchases, money } from './billing.js';

// #509: the owner's CLI. The server decides who may see this; these pin what is shown and that every subcommand is there.

describe('pas billing', () => {
  it('has products, purchases and entitlements, each with --app', () => {
    expect(billingCommand.commands.map((c) => c.name()).sort()).toEqual(['entitlements', 'products', 'purchases']);
    for (const c of billingCommand.commands) expect(c.options.map((o) => o.long)).toContain('--app');
  });

  it('formats money from the smallest unit', () => {
    expect(money(1234, 'aud')).toBe('12.34 AUD');
    expect(money(5, null)).toBe('0.05');
  });

  it('says plainly when billing is off, and shows a sync error', () => {
    const out = formatProducts(false, [{ key: 'term', name: 'Term', amount: 1000, currency: 'aud', modes: ['one_time', 'recurring'], interval: { unit: 'month', count: 3 }, active: true, syncError: 'stripe down' }]);
    expect(out).toContain('not enabled');
    expect(out).toContain('10.00 AUD');
    expect(out).toContain('every 3 month');
    expect(out).toContain('sync error: stripe down');
  });

  it('shows refunds, a pending fee, net and totals per purchase', () => {
    const row = { purchaseId: 'abcdef123456', product: 'term', buyerUserId: 'gh:2', subjects: ['kid-a', 'kid-b'], status: 'paid', createdAt: Date.UTC(2026, 9, 1), currency: 'aud', gross: 2000, refunded: 500, fee: null, net: 1500 };
    const out = formatPurchases([row, { ...row, purchaseId: 'ffffffff0000', fee: 88, net: 1412 }], [{ currency: 'aud', gross: 4000, refunded: 1000, fee: 88, net: 2912 }]);
    expect(out).toContain('2026-10-01  abcdef12');
    expect(out).toContain('refunded 5.00 AUD');
    expect(out).toContain('fee pending');
    expect(out).toContain('fee 0.88 AUD');
    expect(out).toContain('TOTAL AUD: gross 40.00 AUD  refunded 10.00 AUD  fees 0.88 AUD  net 29.12 AUD');
    expect(formatPurchases([], [])).toBe('No paid purchases.\n');
  });

  it('shows entitlements with grace and renewal', () => {
    const out = formatEntitlements([
      { product: 'term', subject: 'kid-a', status: 'grace', periodEnd: Date.UTC(2026, 9, 1), graceUntil: Date.UTC(2026, 9, 6), renews: true, buyerUserId: 'gh:2' },
      { product: 'donation', subject: '', status: 'active', periodEnd: null, graceUntil: null, renews: false, buyerUserId: null },
    ]);
    expect(out).toContain('grace to 2026-10-06');
    expect(out).toContain('renews');
    expect(out).toContain('(none)');
    expect(formatEntitlements([])).toBe('No entitlements.\n');
  });
});
