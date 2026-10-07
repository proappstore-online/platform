import { SELF, env as providedEnv } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../backend/src/types';
import { BASE, mockNetwork, resetTables } from './helpers';

const env = providedEnv as unknown as Env;

// #321 on workerd and real D1: Stripe does not order or deduplicate webhook
// deliveries, so a cancelled subscription must stay cancelled whatever order
// checkout.session.completed and customer.subscription.deleted arrive in, and
// however often. Only a genuinely new subscription id may restore access.

const SECRET = 'whsec_runtime'; // vitest.backend.ts STRIPE_WEBHOOK_SECRET
const T = 1_790_000_000; // a fixed event clock, unix seconds

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function deliver(event: Record<string, unknown>): Promise<number> {
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const res = await SELF.fetch(`${BASE}/webhooks/stripe`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${await hmacHex(SECRET, `${t}.${body}`)}` } });
  await res.text();
  return res.status;
}
const checkout = (sub: string, created: number) => deliver({
  id: `evt_co_${sub}_${created}`, type: 'checkout.session.completed', created,
  data: { object: { metadata: { user_id: 'gh:1' }, customer: 'cus_1', subscription: sub } },
});
const deleted = (sub: string, created: number) => deliver({ id: `evt_del_${sub}`, type: 'customer.subscription.deleted', created, data: { object: { id: sub } } });
const updated = (sub: string, status: string, created: number) => deliver({
  id: `evt_up_${sub}_${status}`, type: 'customer.subscription.updated', created,
  data: { object: { id: sub, status, cancel_at_period_end: false, items: { data: [{ current_period_end: T + 30 * 86400, price: { id: 'price_1' } }] } } },
});
const row = () => env.DB.prepare("SELECT stripe_subscription_id AS sub, status, tier FROM subscriptions WHERE user_id = 'gh:1'").first<{ sub: string; status: string; tier: string }>();

beforeEach(async () => {
  mockNetwork();
  await resetTables();
  for (const t of ['subscriptions', 'stripe_terminated_subscriptions']) await env.DB.prepare(`DELETE FROM ${t}`).run();
});

describe('Stripe webhook ordering: a cancellation is terminal (#321)', () => {
  it('in order: checkout then deletion leaves the subscription cancelled; a redelivered checkout does not revive it', async () => {
    expect(await checkout('sub_A', T)).toBe(200);
    expect(await row()).toEqual({ sub: 'sub_A', status: 'active', tier: 'pro' });
    expect(await deleted('sub_A', T + 10)).toBe(200);
    expect(await checkout('sub_A', T)).toBe(200); // the same event, redelivered late
    expect(await row()).toEqual({ sub: 'sub_A', status: 'canceled', tier: 'free' });
  });

  it('out of order: a deletion that arrives before its checkout still wins', async () => {
    expect(await deleted('sub_A', T + 10)).toBe(200); // no row yet: nothing to cancel, but the end is recorded
    expect(await checkout('sub_A', T)).toBe(200);
    expect(await row()).toBeNull(); // never activated
  });

  it('duplicates are idempotent: repeated checkouts of a live subscription stay active, repeated deletions stay cancelled', async () => {
    for (let i = 0; i < 3; i++) expect(await checkout('sub_A', T)).toBe(200);
    expect(await row()).toMatchObject({ sub: 'sub_A', status: 'active' });
    for (let i = 0; i < 3; i++) expect(await deleted('sub_A', T + 10)).toBe(200);
    expect(await row()).toMatchObject({ sub: 'sub_A', status: 'canceled' });
  });

  it('an update to a terminal status ends it too: a late checkout of that subscription cannot revive it', async () => {
    await checkout('sub_A', T);
    expect(await updated('sub_A', 'canceled', T + 5)).toBe(200);
    await checkout('sub_A', T);
    expect(await row()).toMatchObject({ sub: 'sub_A', status: 'canceled' });
  });

  it('a genuine re-subscribe (a new subscription id) restores access; a late checkout of the old one cannot take it back', async () => {
    await checkout('sub_A', T);
    await deleted('sub_A', T + 10);
    expect(await checkout('sub_B', T + 100)).toBe(200);
    expect(await row()).toEqual({ sub: 'sub_B', status: 'active', tier: 'pro' });
    await checkout('sub_A', T); // the old, cancelled subscription's checkout, redelivered
    expect(await row()).toEqual({ sub: 'sub_B', status: 'active', tier: 'pro' });
    await deleted('sub_A', T + 10); // its deletion redelivered: touches only sub_A, not the new row
    expect(await row()).toMatchObject({ sub: 'sub_B', status: 'active' });
  });

  it('an older checkout for a different subscription cannot replace a newer active one', async () => {
    await checkout('sub_B', T + 100);
    await checkout('sub_A', T); // older event, never cancelled, delivered late
    expect(await row()).toMatchObject({ sub: 'sub_B', status: 'active' });
  });

  it('concurrent checkout and deletion of one subscription always end cancelled', async () => {
    for (let round = 0; round < 10; round++) {
      for (const t of ['subscriptions', 'stripe_terminated_subscriptions']) await env.DB.prepare(`DELETE FROM ${t}`).run();
      const sub = `sub_race_${round}`;
      const deliveries = round % 2 ? [checkout(sub, T), deleted(sub, T + 10), checkout(sub, T)] : [deleted(sub, T + 10), checkout(sub, T), checkout(sub, T)];
      expect(await Promise.all(deliveries)).toEqual([200, 200, 200]);
      const r = await row();
      expect(r === null || r.status === 'canceled', `round ${round}: ${JSON.stringify(r)}`).toBe(true);
    }
  });

  it('a past_due or updated event never touches a cancelled row', async () => {
    await checkout('sub_A', T);
    await deleted('sub_A', T + 10);
    expect(await updated('sub_A', 'active', T + 20)).toBe(200);
    expect(await deliver({ id: 'evt_inv', type: 'invoice.payment_failed', created: T + 30, data: { object: { subscription: 'sub_A' } } })).toBe(200);
    expect(await row()).toMatchObject({ status: 'canceled' });
  });
});
