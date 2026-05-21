import { useState, useEffect, useCallback, type ReactNode } from 'react';
import type { ProAppStore } from './index.js';
import type { Subscription } from './types.js';

export interface ProShellProps {
  /** The ProAppStore SDK instance from initPro(). */
  app: ProAppStore;
  /** Your app's content. Only rendered when user is signed in + subscribed. */
  children: ReactNode;
  /** App name shown in the topbar. */
  appName?: string;
  /**
   * If true, allow free users to see the app (no subscription gate).
   *
   * Default: true while the platform has no payments wired up — every PAS app
   * is free to use. Flip the default back to false once Stripe billing is live.
   */
  allowFree?: boolean;
}

type Gate = 'loading' | 'signed-out' | 'no-subscription' | 'ready';

/**
 * ProShell — platform-level Shell for all ProAppStore apps.
 *
 * Handles:
 * - Auth initialization + sign-in gate
 * - Subscription check + upgrade wall (unless allowFree=true)
 * - Topbar with avatar, app name, menu (sign out, delete account, manage billing)
 * - Only renders children when all gates pass
 *
 * Usage:
 * ```tsx
 * import { initPro } from '@proappstore/sdk'
 * import { ProShell } from '@proappstore/sdk/shell'
 *
 * const app = initPro({ appId: 'meetup' })
 *
 * export default function App() {
 *   return (
 *     <ProShell app={app} appName="Meetup">
 *       <MeetupApp />
 *     </ProShell>
 *   )
 * }
 * ```
 */
export function ProShell({ app, children, appName, allowFree = true }: ProShellProps) {
  const [user, setUser] = useState(app.auth.user);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [gate, setGate] = useState<Gate>('loading');
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    app.auth.init();
    return app.auth.onChange((u) => {
      setUser(u);
      if (!u) setGate('signed-out');
    });
  }, [app]);

  // Check subscription after auth.
  // We always fetch — even when allowFree is true — so the topbar can show the
  // PRO badge / billing link to users who do happen to be subscribed. allowFree
  // only controls whether non-active subs get blocked at the gate.
  useEffect(() => {
    if (!user) return;
    app.subscription.status().then((sub) => {
      setSubscription(sub);
      if (allowFree || sub?.status === 'active') {
        setGate('ready');
      } else {
        setGate('no-subscription');
      }
    }).catch(() => {
      setSubscription(null);
      setGate(allowFree ? 'ready' : 'no-subscription');
    });
  }, [user, app, allowFree]);

  const handleSignOut = useCallback(() => {
    app.auth.signOut();
    setMenuOpen(false);
  }, [app]);

  const handleDeleteAccount = useCallback(async () => {
    const subClause = subscription?.status === 'active' ? ' and cancels your subscription' : '';
    if (!confirm(`Delete your account? This permanently removes ALL your data across ALL apps${subClause}. This cannot be undone.`)) return;
    if (!confirm('Are you absolutely sure? Type thinking... Last chance.')) return;
    // Delete all KV data
    try {
      const keys = await app.kv.list();
      for (const key of keys) {
        await app.kv.delete(key);
      }
    } catch {}
    app.auth.signOut();
    setMenuOpen(false);
  }, [app]);

  const handleManageBilling = useCallback(async () => {
    try {
      await app.subscription.openPortal(window.location.href);
    } catch {}
    setMenuOpen(false);
  }, [app]);

  const handleUpgrade = useCallback(async () => {
    await app.subscription.openCheckout({
      priceId: 'price_pro_monthly',
      successUrl: window.location.href + '?upgraded=1',
      cancelUrl: window.location.href,
    });
  }, [app]);

  // --- Gates ---

  if (gate === 'loading') {
    return <div style={styles.center}><p style={styles.muted}>Loading...</p></div>;
  }

  if (gate === 'signed-out') {
    return (
      <div style={styles.center}>
        <div style={styles.card}>
          <h1 style={styles.heading}>{appName || 'ProAppStore'}</h1>
          <p style={styles.muted}>Sign in to your ProAppStore account to continue.</p>
          <button onClick={() => app.auth.signIn()} style={styles.primaryBtn}>
            Sign in with GitHub
          </button>
          <p style={{ ...styles.muted, fontSize: '0.75rem', marginTop: '0.75rem' }}>
            One account for all Pro apps.
          </p>
        </div>
      </div>
    );
  }

  if (gate === 'no-subscription') {
    return (
      <div style={styles.center}>
        <div style={styles.card}>
          <h1 style={styles.heading}>Pro subscription required</h1>
          <p style={styles.muted}>
            {appName || 'This app'} requires an active ProAppStore subscription ($9/month).
          </p>
          <button onClick={handleUpgrade} style={styles.primaryBtn}>
            Subscribe to Pro
          </button>
          <button onClick={handleSignOut} style={styles.ghostBtn}>
            Sign out
          </button>
        </div>
      </div>
    );
  }

  // --- Ready: render app with topbar ---

  return (
    <div style={styles.shell}>
      {/* Topbar */}
      <header style={styles.topbar}>
        <div style={styles.topbarLeft}>
          <a href="https://proappstore.online" style={styles.logoLink}>Pro</a>
          {appName && <span style={styles.appName}>{appName}</span>}
        </div>
        <div style={styles.topbarRight}>
          <button onClick={() => setMenuOpen(!menuOpen)} style={styles.avatarBtn}>
            <img
              src={user?.avatarUrl || ''}
              alt=""
              style={styles.avatar}
            />
          </button>
          {menuOpen && (
            <div style={styles.menu}>
              <div style={styles.menuHeader}>
                <strong>{user?.login}</strong>
                {subscription?.status === 'active' && <span style={styles.proBadge}>PRO</span>}
              </div>
              {subscription?.status === 'active' && (
                <button onClick={handleManageBilling} style={styles.menuItem}>Manage billing</button>
              )}
              <button onClick={handleSignOut} style={styles.menuItem}>Sign out</button>
              <button onClick={handleDeleteAccount} style={{ ...styles.menuItem, color: '#dc2626' }}>Delete account</button>
            </div>
          )}
        </div>
      </header>

      {/* App content */}
      <main style={styles.main}>
        {children}
      </main>
    </div>
  );
}

// --- Inline styles (no Tailwind dependency — works in any app) ---

const styles: Record<string, React.CSSProperties> = {
  shell: { minHeight: '100dvh', display: 'flex', flexDirection: 'column' },
  topbar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.5rem 1rem', borderBottom: '1px solid #e5e5e5', background: '#fff', position: 'sticky', top: 0, zIndex: 50 },
  topbarLeft: { display: 'flex', alignItems: 'center', gap: '0.75rem' },
  topbarRight: { position: 'relative' },
  logoLink: { fontWeight: 800, fontSize: '1rem', color: '#7c3aed', textDecoration: 'none' },
  appName: { fontSize: '0.85rem', fontWeight: 600, color: '#444' },
  avatarBtn: { background: 'none', border: '2px solid #e5e5e5', borderRadius: '50%', padding: 0, cursor: 'pointer', width: 32, height: 32, overflow: 'hidden' },
  avatar: { width: '100%', height: '100%', borderRadius: '50%' },
  menu: { position: 'absolute', top: 40, right: 0, background: '#fff', border: '1px solid #e5e5e5', borderRadius: '0.75rem', boxShadow: '0 4px 20px rgba(0,0,0,0.1)', minWidth: 180, padding: '0.5rem 0', zIndex: 100 },
  menuHeader: { padding: '0.5rem 1rem', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem' },
  menuItem: { display: 'block', width: '100%', padding: '0.5rem 1rem', background: 'none', border: 'none', textAlign: 'left', fontSize: '0.85rem', cursor: 'pointer', color: '#333' },
  proBadge: { fontSize: '0.6rem', fontWeight: 700, background: '#7c3aed', color: '#fff', padding: '0.1rem 0.4rem', borderRadius: '0.25rem' },
  center: { minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem' },
  card: { maxWidth: 400, textAlign: 'center' as const },
  heading: { fontSize: '1.5rem', fontWeight: 800, marginBottom: '0.5rem', color: '#111' },
  muted: { color: '#666', fontSize: '0.9rem', marginBottom: '1rem' },
  primaryBtn: { background: '#7c3aed', color: '#fff', border: 'none', padding: '0.75rem 2rem', borderRadius: '0.75rem', fontSize: '0.9rem', fontWeight: 700, cursor: 'pointer', marginTop: '0.5rem' },
  ghostBtn: { background: 'none', color: '#666', border: 'none', padding: '0.5rem 1rem', fontSize: '0.8rem', cursor: 'pointer', marginTop: '0.5rem' },
  main: { flex: 1, display: 'flex', flexDirection: 'column' },
};
