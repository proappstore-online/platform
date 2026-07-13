import { useState, useEffect, useCallback, useSyncExternalStore } from 'react';
import type { ProAppStore } from './index.js';
import type { Subscription } from './types.js';
import { resolveApp } from './provider.js';

// Re-export User type for convenience
export type { User } from './base-types.js';
export type { NotificationPayload, SendResult } from './notifications.js';

// ---------------------------------------------------------------------------
// useTheme — vendored from @freeappstore/sdk/hooks
// ---------------------------------------------------------------------------

const THEME_KEY = 'stores-theme';
type ThemePreference = 'light' | 'dark' | 'system';
type ResolvedTheme = 'light' | 'dark';

const themeListeners = new Set<() => void>();

function getSystemTheme(): ResolvedTheme {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function getStoredPreference(): ThemePreference {
  if (typeof window === 'undefined') return 'system';
  const stored = window.localStorage.getItem(THEME_KEY);
  if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  return 'system';
}

function resolveTheme(pref: ThemePreference): ResolvedTheme {
  return pref === 'system' ? getSystemTheme() : pref;
}

function applyTheme(theme: ResolvedTheme): void {
  if (typeof document === 'undefined') return;
  if (theme === 'dark') {
    document.documentElement.dataset.theme = 'dark';
  } else {
    delete document.documentElement.dataset.theme;
  }
}

function notifyThemeListeners(): void {
  for (const fn of themeListeners) fn();
}

if (typeof window !== 'undefined') {
  applyTheme(resolveTheme(getStoredPreference()));
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (getStoredPreference() === 'system') {
      applyTheme(getSystemTheme());
      notifyThemeListeners();
    }
  });
}

function subscribeTheme(cb: () => void): () => void {
  themeListeners.add(cb);
  return () => themeListeners.delete(cb);
}

function getThemeSnapshot(): { theme: ResolvedTheme; preference: ThemePreference } {
  const preference = getStoredPreference();
  return { theme: resolveTheme(preference), preference };
}

let cachedSnapshot = getThemeSnapshot();

function getSnapshot(): { theme: ResolvedTheme; preference: ThemePreference } {
  return cachedSnapshot;
}

/**
 * Theme hook — zero-provider. Persists preference, applies data-theme on html element.
 * Shared with FAS SDK (vendored, same localStorage key).
 */
export function useTheme() {
  const snapshot = useSyncExternalStore(subscribeTheme, getSnapshot, getSnapshot);

  const setPreference = useCallback((pref: ThemePreference) => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(THEME_KEY, pref);
    applyTheme(resolveTheme(pref));
    cachedSnapshot = getThemeSnapshot();
    notifyThemeListeners();
  }, []);

  return { theme: snapshot.theme, preference: snapshot.preference, setPreference };
}

/**
 * Auth state + actions. The primary way apps interact with platform identity.
 *
 * Usage:
 * ```tsx
 * const { user, loading, signIn, signOut, deleteAccount } = useAuth()
 * if (loading) return <Spinner />
 * if (!user) return <MySignInPage onSignIn={signIn} />
 * return <MyApp user={user} onSignOut={signOut} />
 * ```
 */
export function useAuth(app?: ProAppStore) {
  app = resolveApp(app);
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
 * const { subscription, isPro, loading, upgrade, manageBilling } = useSubscription()
 * if (!isPro) return <UpgradePrompt onUpgrade={upgrade} />
 * ```
 */
export function useSubscription(app?: ProAppStore) {
  app = resolveApp(app);
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
    const checkoutPriceId = priceId ?? (await app.subscription.pricing()).proMonthly?.priceId;
    if (!checkoutPriceId) throw new Error('Subscription billing is not configured.');
    await app.subscription.openCheckout({
      priceId: checkoutPriceId,
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
 * const { permission, isSubscribed, subscribe, unsubscribe, loading } = useNotifications()
 * if (permission === 'denied') return null
 * return (
 *   <button onClick={isSubscribed ? unsubscribe : subscribe}>
 *     {isSubscribed ? 'Enabled' : 'Enable notifications'}
 *   </button>
 * )
 * ```
 */
export function useNotifications(app?: ProAppStore) {
  app = resolveApp(app);
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
 * const { gate, user, subscription, signIn, upgrade } = useGate()
 * if (gate === 'loading') return <Spinner />
 * if (gate === 'signed-out') return <SignInPage onSignIn={signIn} />
 * if (gate === 'no-subscription') return <UpgradePage onUpgrade={upgrade} />
 * // gate === 'ready' — user is signed in and subscribed
 * return <MyApp user={user!} />
 * ```
 */
export function useGate(app?: ProAppStore, opts?: { allowFree?: boolean }) {
  app = resolveApp(app);
  const auth = useAuth(app);
  const sub = useSubscription(app);

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

// Backward-compat aliases (old names still work)
/** @deprecated Use `useAuth` instead. */
export const useProAuth = useAuth;
/** @deprecated Use `useSubscription` instead. */
export const useProSubscription = useSubscription;
/** @deprecated Use `useGate` instead. */
export const useProGate = useGate;
/** @deprecated Use `useNotifications` instead. */
export const useProNotifications = useNotifications;
