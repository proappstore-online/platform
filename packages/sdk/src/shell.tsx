import { useState, useEffect, useCallback, type ReactNode } from 'react';
import type { ProAppStore } from './index.js';
import type { Subscription } from './types.js';
import { ProfileMenu, SignInButton, ProBadge, GateScreen } from './ui.js';

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
  /** Show theme toggle in the profile menu. Default: true. */
  showThemeToggle?: boolean;
}

type Gate = 'loading' | 'signed-out' | 'no-subscription' | 'ready';

/**
 * ProShell — platform-level Shell for all ProAppStore apps.
 *
 * Handles:
 * - Auth initialization + sign-in gate
 * - Subscription check + upgrade wall (unless allowFree=true)
 * - Topbar with avatar, app name, menu (sign out, delete account, manage billing)
 * - Theme support via CSS custom properties
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
export function ProShell({ app, children, appName, allowFree = true, showThemeToggle = true }: ProShellProps) {
  const [user, setUser] = useState(app.auth.user);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [gate, setGate] = useState<Gate>('loading');

  useEffect(() => {
    app.auth.init();
    return app.auth.onChange((u) => {
      setUser(u);
      if (!u) setGate('signed-out');
    });
  }, [app]);

  // Check subscription after auth.
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

  // --- Gates ---
  if (gate !== 'ready') {
    return <GateScreen gate={gate} app={app} appName={appName} />;
  }

  // --- Ready: render app with topbar ---
  return (
    <div style={styles.shell}>
      <header style={styles.topbar}>
        <div style={styles.topbarLeft}>
          <a href="https://proappstore.online" style={styles.logoLink}>Pro</a>
          {appName && <span style={styles.appName}>{appName}</span>}
          {subscription?.status === 'active' && <ProBadge />}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {!user && <SignInButton app={app} label="Sign in" />}
          {user && <ProfileMenu app={app} showThemeToggle={showThemeToggle} />}
        </div>
      </header>

      <main style={styles.main}>
        {children}
      </main>

      <footer style={styles.footer}>
        Part of{' '}
        <a href="https://proappstore.online" style={{ color: 'var(--accent, #7c3aed)', fontWeight: 600, textDecoration: 'none' }}>
          ProAppStore
        </a>
      </footer>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  shell: { minHeight: '100dvh', display: 'flex', flexDirection: 'column' },
  topbar: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '0.5rem 1rem',
    borderBottom: '1px solid var(--border, #e2e8f0)',
    background: 'var(--surface, #ffffff)',
    position: 'sticky', top: 0, zIndex: 50,
  },
  topbarLeft: { display: 'flex', alignItems: 'center', gap: '0.75rem' },
  logoLink: { fontWeight: 800, fontSize: '1rem', color: 'var(--accent, #7c3aed)', textDecoration: 'none' },
  appName: { fontSize: '0.85rem', fontWeight: 600, color: 'var(--muted, #64748b)' },
  main: { flex: 1, display: 'flex', flexDirection: 'column' },
  footer: {
    padding: '1rem', textAlign: 'center', fontSize: '0.75rem',
    color: 'var(--muted, #64748b)',
    borderTop: '1px solid var(--border, #e2e8f0)',
  },
};
