import { useState, useEffect, type ReactNode } from 'react';
import type { ProAppStore } from './index.js';
import type { User } from './base-types.js';
import type { Subscription } from './types.js';
import { ProfileMenu, ProBadge, GateScreen, TextSizeToggle } from './ui.js';
import { ProProvider } from './provider.js';

export interface MenuItem {
  label: string;
  onClick: () => void;
}

export interface ProShellRenderContext {
  /** The SDK instance passed to ProShell. */
  app: ProAppStore;
  /** App name passed to ProShell, if any. */
  appName: string | undefined;
  /** Signed-in user. ProShell only calls render functions after auth gates pass. */
  user: User;
  /** Current subscription result, or null if unavailable/free-gated. */
  subscription: Subscription | null;
  /** Text size control used by the default shell. */
  textSizeToggle: ReactNode;
  /** Platform profile dropdown, including any menuItems passed to ProShell. */
  profileMenu: ReactNode;
  /** PRO badge when the current subscription is active; otherwise null. */
  proBadge: ReactNode;
}

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
   * Default: true preserves backwards compatibility for existing apps. Apps that
   * should require a paid PAS subscription must pass allowFree={false}.
   */
  allowFree?: boolean;
  /** Show theme toggle in the profile menu. Default: true. */
  showThemeToggle?: boolean;
  /** Custom items added to the profile dropdown (above sign-out). */
  menuItems?: MenuItem[];
  /** Hide the default ProShell topbar. Use when the app renders its own navigation. */
  hideTopbar?: boolean;
  /** Hide the default ProShell footer. */
  hideFooter?: boolean;
  /**
   * Replace the default topbar while keeping ProShell's auth/subscription gates.
   *
   * Use the provided `profileMenu`, `textSizeToggle`, and `proBadge` nodes to
   * keep platform account controls consistent in custom app navigation.
   */
  renderTopbar?: (ctx: ProShellRenderContext) => ReactNode;
  /** Replace the default footer. Return null to omit it. */
  renderFooter?: (ctx: ProShellRenderContext) => ReactNode;
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
export function ProShell({
  app,
  children,
  appName,
  allowFree = true,
  showThemeToggle = true,
  menuItems,
  hideTopbar = false,
  hideFooter = false,
  renderTopbar,
  renderFooter,
}: ProShellProps) {
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

  if (!user) {
    return <GateScreen gate="signed-out" app={app} appName={appName} />;
  }

  const profileMenu = (
    <ProfileMenu app={app} showThemeToggle={showThemeToggle}>
      {menuItems?.map((item, i) => (
        <button key={i} onClick={item.onClick} style={menuItemStyle}>{item.label}</button>
      ))}
    </ProfileMenu>
  );

  const shellContext: ProShellRenderContext = {
    app,
    appName,
    user,
    subscription,
    textSizeToggle: <TextSizeToggle />,
    profileMenu,
    proBadge: subscription?.status === 'active' ? <ProBadge /> : null,
  };

  const topbar = renderTopbar ? renderTopbar(shellContext) : hideTopbar ? null : (
    <header style={styles.topbar}>
      <div style={styles.topbarLeft}>
        <a href="https://proappstore.online" style={styles.logoLink}>Pro</a>
        {appName && <span style={styles.appName}>{appName}</span>}
        {shellContext.proBadge}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        {shellContext.textSizeToggle}
        {shellContext.profileMenu}
      </div>
    </header>
  );

  const footer = renderFooter ? renderFooter(shellContext) : hideFooter ? null : (
    <footer style={styles.footer}>
      Part of{' '}
      <a href="https://proappstore.online" style={{ color: 'var(--accent)', fontWeight: 600, textDecoration: 'none' }}>
        ProAppStore
      </a>
    </footer>
  );

  // --- Ready: render app with topbar ---
  return (
    <ProProvider app={app}>
    <div style={styles.shell}>
      {topbar}

      <main style={styles.main}>
        {children}
      </main>

      {footer}
    </div>
    </ProProvider>
  );
}

const menuItemStyle: React.CSSProperties = {
  display: 'block', width: '100%', padding: '0.5rem 1rem',
  background: 'none', border: 'none', textAlign: 'left',
  fontSize: '0.85rem', cursor: 'pointer',
  color: 'var(--ink)', fontFamily: 'inherit',
};

const styles: Record<string, React.CSSProperties> = {
  shell: { minHeight: '100dvh', display: 'flex', flexDirection: 'column' },
  topbar: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '0.5rem 1rem',
    borderBottom: '1px solid var(--line)',
    background: 'var(--panel)',
    position: 'sticky', top: 0, zIndex: 50,
  },
  topbarLeft: { display: 'flex', alignItems: 'center', gap: '0.75rem' },
  logoLink: { fontWeight: 800, fontSize: '1rem', color: 'var(--accent)', textDecoration: 'none' },
  appName: { fontSize: '0.85rem', fontWeight: 600, color: 'var(--muted)' },
  main: { flex: 1, display: 'flex', flexDirection: 'column' },
  footer: {
    padding: '1rem', textAlign: 'center', fontSize: '0.75rem',
    color: 'var(--muted)',
    borderTop: '1px solid var(--line)',
  },
};
