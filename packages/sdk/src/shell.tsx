import { Suspense, useEffect, useInsertionEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ProAppStore } from './index.js';
import type { User } from './base-types.js';
import type { Subscription } from './types.js';
import { ProfileMenu, ProBadge, GateScreen, TextSizeToggle, Spinner } from './ui.js';
import { ProProvider } from './provider.js';
import { activeHref, NavBar, useCurrentPath, type NavItem } from './navbar.js';
import { SHELL_CSS } from './shell-css.js';
import {
  OfflineBanner,
  ShellErrorBoundary,
  SkipLink,
  ToastProvider,
  useRouteChangeEffects,
  type ShellErrorContext,
} from './shell-resilience.js';

export type { NavItem } from './navbar.js';
export type { ShellErrorContext } from './shell-resilience.js';

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
  /** The app's main navigation (`nav` / `renderNav`), or null when none is declared.
   *  A custom `renderTopbar` should place it. */
  nav: ReactNode;
}

export interface ProShellNavContext {
  items: NavItem[];
  /** The path the shell considers current (`location.pathname`, following back/forward). */
  currentPath: string;
  /** Navigate to `href`: the shell's `onNavigate`, else a full page load. */
  onNavigate: (href: string) => void;
}

export interface ProShellProps {
  /** The ProAppStore SDK instance from initPro(). */
  app: ProAppStore;
  /** Your app's content. Only rendered when user is signed in + subscribed. */
  children: ReactNode;
  /** App name shown in the topbar. */
  appName?: string;
  /**
   * The app's screens — the standard way to give an app navigation (#235).
   * ProShell renders them as a `<nav aria-label="Main">` in its topbar, marks
   * the current route, and collapses to a menu button on small screens.
   *
   * ```tsx
   * <ProShell app={app} appName="Cases" nav={[{ label: 'Home', href: '/' }, { label: 'Cases', href: '/cases' }]}>
   * ```
   */
  nav?: NavItem[];
  /** Replace the built-in NavBar (still placed in the topbar) with your own. */
  renderNav?: (ctx: ProShellNavContext) => ReactNode;
  /**
   * Client-side navigation for nav clicks (e.g. your router's `navigate`).
   * Without it, nav items are ordinary links (full page load).
   */
  onNavigate?: (href: string) => void;
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
  /** Hide the default ProShell topbar. Prefer `nav`; this also hides the navigation. */
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
  /**
   * Replace the fallback shown when a screen throws while rendering (#236).
   * The error is already recorded via `app.logs`; call `reset` to retry.
   */
  renderError?: (ctx: ShellErrorContext) => ReactNode;
  /** Replace the spinner shown while a lazy-loaded screen loads (#236). */
  renderLoading?: () => ReactNode;
}

type Gate = 'loading' | 'signed-out' | 'no-subscription' | 'ready';

/**
 * ProShell — platform-level Shell for all ProAppStore apps.
 *
 * Handles:
 * - Auth initialization + sign-in gate
 * - Subscription check + upgrade wall (unless allowFree=true)
 * - Topbar with avatar, app name, menu (sign out, delete account, manage billing)
 * - Main navigation from the `nav` prop (<nav aria-label="Main">, current route, mobile menu)
 * - Resilience and feedback (#236): error boundary + Suspense around the content,
 *   `useToast` region, offline banner, skip link, nav-item titles, and scroll +
 *   focus handling on client-side route changes
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
 *     <ProShell app={app} appName="Meetup" nav={[{ label: 'Events', href: '/' }, { label: 'Groups', href: '/groups' }]}>
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
  nav,
  renderNav,
  onNavigate,
  allowFree = true,
  showThemeToggle = true,
  menuItems,
  hideTopbar = false,
  hideFooter = false,
  renderTopbar,
  renderFooter,
  renderError,
  renderLoading,
}: ProShellProps) {
  const [user, setUser] = useState(app.auth.user);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [gate, setGate] = useState<Gate>('loading');
  const [currentPath, setCurrentPath] = useCurrentPath();
  const mainRef = useRef<HTMLElement>(null);
  const beforeNavigate = useRouteChangeEffects(currentPath, mainRef, onNavigate !== undefined);

  useInsertionEffect(() => {
    if (document.getElementById('pas-shell-css')) return;
    const style = document.createElement('style');
    style.id = 'pas-shell-css';
    style.textContent = SHELL_CSS;
    document.head.appendChild(style);
  }, []);

  // A nav item's `title` becomes the tab title on its route. A layout effect runs
  // before every passive effect, so a screen's own useDocumentTitle still wins.
  const navItems = nav ?? [];
  const activeItem = navItems.find((item) => item.href === activeHref(navItems, currentPath));
  const navTitle = activeItem?.title;
  useLayoutEffect(() => {
    if (navTitle) document.title = navTitle;
  }, [navTitle, currentPath]);

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

  // Client-side navigation goes through the shell, so it knows the route changed
  // (scroll, focus, titles). Without onNavigate, items are plain links.
  const navigate = onNavigate
    ? (href: string) => {
      beforeNavigate();
      onNavigate(href);
      setCurrentPath(href);
    }
    : undefined;
  const navNode = navItems.length === 0 ? null : renderNav
    ? renderNav({
      items: navItems,
      currentPath,
      onNavigate: navigate ?? ((href) => window.location.assign(href)),
    })
    : navigate
      ? <NavBar items={navItems} currentPath={currentPath} onNavigate={navigate} />
      : <NavBar items={navItems} />;

  const shellContext: ProShellRenderContext = {
    app,
    appName,
    user,
    subscription,
    textSizeToggle: <TextSizeToggle />,
    profileMenu,
    proBadge: subscription?.status === 'active' ? <ProBadge /> : null,
    nav: navNode,
  };

  const topbar = renderTopbar ? renderTopbar(shellContext) : hideTopbar ? null : (
    <header style={styles.topbar}>
      <div style={styles.topbarLeft}>
        <a href="https://proappstore.online" style={styles.logoLink}>Pro</a>
        {appName && <span style={styles.appName}>{appName}</span>}
        {shellContext.proBadge}
      </div>
      {shellContext.nav}
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

  const loading = renderLoading ? renderLoading() : (
    <div className="pas-shell-loading flex flex-1 items-center justify-center px-4 py-12">
      <Spinner size={28} />
    </div>
  );

  // --- Ready: render app with topbar ---
  return (
    <ProProvider app={app}>
    <ToastProvider>
    <div style={styles.shell}>
      <SkipLink mainRef={mainRef} />
      {topbar}
      <OfflineBanner />

      <main id="main" ref={mainRef} tabIndex={-1} className="pas-main" style={styles.main}>
        <ShellErrorBoundary app={app} renderError={renderError} resetKey={currentPath}>
          <Suspense fallback={loading}>{children}</Suspense>
        </ShellErrorBoundary>
      </main>

      {footer}
    </div>
    </ToastProvider>
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
