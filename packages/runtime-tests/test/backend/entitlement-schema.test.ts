import { env as providedEnv } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../backend/src/types';

const env = providedEnv as unknown as Env;

// #508 step 1, on real D1 and the real migrations: the entitlement tables exist and enforce what the logic relies on.
// An event id, a payment id and an entitlement key are each one row however many times they are written.

const run = (sql: string, ...binds: unknown[]) => env.DB.prepare(sql).bind(...binds).run();
const count = async (table: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;

beforeEach(async () => {
  for (const t of ['app_billing_events', 'app_billing_payments', 'app_billing_payment_refs', 'app_entitlements', 'app_purchases']) await run(`DELETE FROM ${t}`);
});

describe('entitlement tables (#508)', () => {
  it('an event id is one row: the second INSERT OR IGNORE changes nothing, and processed_at is kept', async () => {
    await run("INSERT OR IGNORE INTO app_billing_events (event_id, type, app_id, received_at, processed_at) VALUES ('evt_1', 'invoice.paid', 'club', 1, 5)");
    const again = await run("INSERT OR IGNORE INTO app_billing_events (event_id, type, app_id, received_at) VALUES ('evt_1', 'invoice.paid', 'club', 9)");
    expect(again.meta.changes).toBe(0);
    expect(await count('app_billing_events')).toBe(1);
    expect(await env.DB.prepare("SELECT received_at, processed_at FROM app_billing_events WHERE event_id = 'evt_1'").first()).toEqual({ received_at: 1, processed_at: 5 });
  });

  it('a payment id is one row, so the same payment arriving twice buys time once', async () => {
    const ins = () => run("INSERT OR IGNORE INTO app_billing_payments (id, purchase_id, paid_at, amount, currency, created_at) VALUES ('in:1', 'p1', 100, 1000, 'aud', 1)");
    expect((await ins()).meta.changes).toBe(1);
    expect((await ins()).meta.changes).toBe(0);
    expect(await count('app_billing_payments')).toBe(1);
  });

  it('a payment ref resolves to one purchase', async () => {
    await run("INSERT OR IGNORE INTO app_billing_payment_refs (ref, purchase_id) VALUES ('ch_1', 'p1')");
    await run("INSERT OR IGNORE INTO app_billing_payment_refs (ref, purchase_id) VALUES ('ch_1', 'p2')");
    expect((await env.DB.prepare("SELECT purchase_id FROM app_billing_payment_refs WHERE ref = 'ch_1'").first<{ purchase_id: string }>())?.purchase_id).toBe('p1');
  });

  it('an entitlement is one row per (app, product, subject), and the empty subject is a subject', async () => {
    const put = (subject: string) => run("INSERT OR IGNORE INTO app_entitlements (app_id, product_key, subject, status, created_at, updated_at) VALUES ('club', 'term', ?, 'active', 1, 1)", subject);
    await put('kid-a');
    await put('kid-a');
    await put('kid-b');
    await put('');
    await put('');
    expect(await count('app_entitlements')).toBe(3);
  });

  it('refuses a status the logic does not produce, and starts unmirrored at version 1', async () => {
    await expect(run("INSERT INTO app_entitlements (app_id, product_key, subject, status, created_at, updated_at) VALUES ('club', 'term', 'x', 'paid', 1, 1)")).rejects.toThrow(/CHECK|constraint/i);
    await run("INSERT INTO app_entitlements (app_id, product_key, subject, status, created_at, updated_at) VALUES ('club', 'term', 'x', 'canceled', 1, 1)");
    expect(await env.DB.prepare("SELECT version, mirrored_version, renews FROM app_entitlements WHERE subject = 'x'").first()).toEqual({ version: 1, mirrored_version: 0, renews: 0 });
  });

  it('the purchase gained the term and fact columns, with safe defaults', async () => {
    await run("INSERT INTO app_purchases (id, app_id, product_key, buyer_user_id, subjects, quantity, mode, status, created_at, updated_at) VALUES ('p1', 'club', 'term', 'gh:1', '[]', 1, 'one_time', 'pending', 1, 1)");
    expect(await env.DB.prepare('SELECT interval_unit, interval_count, grace_days, stripe_subscription_id, failed_at, refunded_at, sub_cancel_at_period_end, sub_ended_at, sub_event_at FROM app_purchases WHERE id = ?').bind('p1').first())
      .toEqual({ interval_unit: null, interval_count: null, grace_days: 0, stripe_subscription_id: null, failed_at: null, refunded_at: null, sub_cancel_at_period_end: 0, sub_ended_at: null, sub_event_at: 0 });
  });
});
