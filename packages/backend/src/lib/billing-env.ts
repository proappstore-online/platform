import type { Env } from '../types.js';
import { HttpError } from './auth.js';
import { Stripe } from './stripe.js';
import type { StripeEnv } from './stripe-env.js';

/**
 * Resolving app billing's test-mode isolation (#519): which Stripe key an env uses, and the one identity
 * test-mode checkout is restricted to. Never a fallback from test to live — a missing test key is a 503
 * before any Stripe call, not a silent switch to the live account.
 */

function stripeKeyFor(env: Env, stripeEnv: StripeEnv): string {
  const key = stripeEnv === 'test' ? env.STRIPE_TEST_SECRET_KEY : env.STRIPE_SECRET_KEY;
  if (!key) throw new HttpError(`Stripe ${stripeEnv} mode is not configured on this platform`, 503);
  return key;
}

export function stripeFor(env: Env, stripeEnv: StripeEnv): Stripe {
  return new Stripe(stripeKeyFor(env, stripeEnv));
}

/**
 * Whether a user id is a managed, non-human test principal (#432): the only identity test-mode checkout
 * permits (#519). Test principals have no provider login, so this structurally keeps general users out of
 * test-mode checkout rather than relying on policy alone.
 */
export async function isTestPrincipal(db: D1Database, userId: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS x FROM test_principals WHERE user_id = ? AND status = 'active'").bind(userId).first();
  return !!row;
}
