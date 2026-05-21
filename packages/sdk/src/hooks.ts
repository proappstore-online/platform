import { useState, useEffect, useCallback } from 'react';
import type { ProAppStore } from './index.js';
import type { Subscription } from './types.js';

// Re-export User type for convenience
export type { User } from '@freeappstore/sdk';
export type { NotificationPayload, SendResult } from './notifications.js';

/**
 * Auth state + actions. The primary way apps interact with platform identity.
 *
 * Usage:
 * ```tsx
 * const { user, loading, signIn, signOut, deleteAccount } = useProAuth(app)
 * if (loading) return <Spinner />
 * if (!user) return <MySignInPage onSignIn={signIn} />
 * return <MyApp user={user} onSignOut={signOut} />
 * ```
 */
export function useProAuth(app: ProAppStore) {
  const [user, setUser] = useState(app.auth.user);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    app.auth.init().finally(() => setLoading(false));
    return app.auth.onChange(setUser);
  }, [app]);

  const signIn = useCallback(() => app.auth.signIn(), [app]);
  const signOut = useCallback(() => app.auth.signOut(), [app]);

  const deleteAccount = useCallback(async () => {
    try {
      const keys = await app.kv.list();
      for (const key of keys) {
        await app.kv.delete(key).catch(() => {});
      }
    } catch {}
    app.auth.signOut();
  }, [app]);

  return { user, loading, signIn, signOut, deleteAccount };
}

/**
 * Subscription state + actions. Check if user is subscribed, upgrade, manage billing.
 *
 * Usage:
 * ```tsx
 * const { subscription, isPro, loading, upgrade, manageBilling } = useProSubscription(app)
 * if (!isPro) return <UpgradePrompt onUpgrade={upgrade} />
 * ```
 */
export function useProSubscription(app: ProAppStore) {
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!app.auth.token) {
      setLoading(false);
      return;
    }
    app.subscription.status()
      .then(setSubscription)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [app, app.auth.user]);

  const isPro = subscription?.status === 'active';

  const upgrade = useCallback(async (priceId?: string) => {
    await app.subscription.openCheckout({
      priceId: priceId || 'price_pro_monthly',
      successUrl: window.location.href + (window.location.href.includes('?') ? '&' : '?') + 'upgraded=1',
      cancelUrl: window.location.href,
    });
  }, [app]);

  const manageBilling = useCallback(async () => {
    await app.subscription.openPortal(window.location.href);
  }, [app]);

  return { subscription, isPro, loading, upgrade, manageBilling };
}

/**
 * Push notification state + actions.
 *
 * Usage:
 * ```tsx
 * const { permission, isSubscribed, subscribe, unsubscribe, loading } = useProNotifications(app)
 * if (permission === 'denied') return null
 * return (
 *   <button onClick={isSubscribed ? unsubscribe : subscribe}>
 *     {isSubscribed ? 'Enabled' : 'Enable notifications'}
 *   </button>
 * )
 * ```
 */
export function useProNotifications(app: ProAppStore) {
  const [permission, setPermission] = useState<NotificationPermission>(
    app.notifications.getPermission(),
  );
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    app.notifications.isSubscribed()
      .then(setIsSubscribed)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [app]);

  const subscribe = useCallback(async () => {
    setLoading(true);
    try {
      await app.notifications.subscribe();
      setIsSubscribed(true);
      setPermission(app.notifications.getPermission());
    } finally {
      setLoading(false);
    }
  }, [app]);

  const unsubscribe = useCallback(async () => {
    setLoading(true);
    try {
      await app.notifications.unsubscribe();
      setIsSubscribed(false);
    } finally {
      setLoading(false);
    }
  }, [app]);

  return { permission, isSubscribed, subscribe, unsubscribe, loading };
}

/**
 * Combined auth + subscription gate. Returns the current gate state.
 *
 * Usage:
 * ```tsx
 * const { gate, user, subscription, signIn, upgrade } = useProGate(app)
 * if (gate === 'loading') return <Spinner />
 * if (gate === 'signed-out') return <SignInPage onSignIn={signIn} />
 * if (gate === 'no-subscription') return <UpgradePage onUpgrade={upgrade} />
 * // gate === 'ready' — user is signed in and subscribed
 * return <MyApp user={user!} />
 * ```
 */
export function useProGate(app: ProAppStore, opts?: { allowFree?: boolean }) {
  const auth = useProAuth(app);
  const sub = useProSubscription(app);

  // allowFree defaults to true while the platform has no payments wired up —
  // see ProShell for the matching default. Flip back when Stripe is live.
  const allowFree = opts?.allowFree ?? true;

  let gate: 'loading' | 'signed-out' | 'no-subscription' | 'ready';

  if (auth.loading || (auth.user && sub.loading)) {
    gate = 'loading';
  } else if (!auth.user) {
    gate = 'signed-out';
  } else if (!allowFree && !sub.isPro) {
    gate = 'no-subscription';
  } else {
    gate = 'ready';
  }

  return {
    gate,
    user: auth.user,
    subscription: sub.subscription,
    isPro: sub.isPro,
    signIn: auth.signIn,
    signOut: auth.signOut,
    deleteAccount: auth.deleteAccount,
    upgrade: sub.upgrade,
    manageBilling: sub.manageBilling,
  };
}
