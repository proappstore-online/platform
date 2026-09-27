import { useEffect, useId, useInsertionEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { NAVBAR_CSS } from './navbar-css.js';

/** One screen in the app's main navigation. */
export interface NavItem {
  label: string;
  /** Same-origin path, e.g. `/` or `/cases`. */
  href: string;
  /** Optional icon, rendered before the label (mark it `aria-hidden`). */
  icon?: ReactNode;
  /**
   * Tab title while this item's route is current (#236, PAS-UI-003). ProShell
   * applies it; a screen's own `useDocumentTitle` overrides it.
   */
  title?: string;
}

export interface NavBarProps {
  items: NavItem[];
  /**
   * The route to mark as current. Defaults to `location.pathname`, kept in
   * step with back/forward (`popstate`). Pass your router's location when you
   * use one.
   */
  currentPath?: string;
  /**
   * Client-side navigation: called instead of a full page load on a plain
   * left click. Without it the items are ordinary links.
   */
  onNavigate?: (href: string) => void;
}

/**
 * The browser's current path, following back/forward. `initial` wins when
 * given (router-driven apps, server rendering).
 */
export function useCurrentPath(initial?: string): [string, (path: string) => void] {
  const [path, setPath] = useState(() => initial ?? (typeof window === 'undefined' ? '/' : window.location.pathname));
  useEffect(() => {
    if (initial !== undefined) {
      setPath(initial);
      return;
    }
    const sync = () => setPath(window.location.pathname);
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, [initial]);
  return [path, setPath];
}

/** The item to mark current: an exact match, else the longest prefix (`/cases` for `/cases/42`). */
export function activeHref(items: NavItem[], path: string): string | null {
  let best: string | null = null;
  for (const { href } of items) {
    const matches = href === path || (href !== '/' && path.startsWith(`${href.replace(/\/+$/, '')}/`));
    if (matches && (best === null || href.length > best.length)) best = href;
  }
  return best;
}

function useNavbarStyles(): void {
  useInsertionEffect(() => {
    if (document.getElementById('pas-nav-css')) return;
    const style = document.createElement('style');
    style.id = 'pas-nav-css';
    style.textContent = NAVBAR_CSS;
    document.head.appendChild(style);
  }, []);
}

/**
 * NavBar (#235) — the app's main navigation, rendered by ProShell's topbar
 * from its `nav` prop, and usable on its own in a custom topbar.
 *
 * `<nav aria-label="Main">` landmark (PAS-UI-003), `aria-current="page"` on the
 * current item, 44 px targets (PAS-UI-009), visible focus, and below 640 px a
 * menu button (`aria-expanded` / `aria-controls`; Escape or a click outside
 * closes it and returns focus). Renders nothing when there are no items.
 */
export function NavBar({ items, currentPath, onNavigate }: NavBarProps) {
  useNavbarStyles();
  const [path, setPath] = useCurrentPath(currentPath);
  const [open, setOpen] = useState(false);
  const listId = useId();
  const navRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (returnFocus: boolean) => {
      setOpen(false);
      if (returnFocus) toggleRef.current?.focus();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(true); };
    const onPointer = (e: PointerEvent) => { if (!navRef.current?.contains(e.target as Node)) close(false); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  if (items.length === 0) return null;
  const current = activeHref(items, path);

  const follow = (e: MouseEvent<HTMLAnchorElement>, href: string) => {
    setOpen(false);
    if (!onNavigate || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onNavigate(href);
    if (currentPath === undefined) setPath(href);
  };

  return (
    <nav ref={navRef} aria-label="Main" className="pas-nav relative flex min-w-0 flex-1 items-center" data-open={open ? 'true' : 'false'}>
      <button
        ref={toggleRef}
        type="button"
        className="pas-nav__toggle inline-flex min-h-11 min-w-11 items-center justify-center rounded-[10px] border border-[var(--line)] text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] sm:hidden"
        aria-expanded={open}
        aria-controls={listId}
        aria-label="Menu"
        onClick={() => setOpen((o) => !o)}
      >
        <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d={open ? 'M6 6l12 12M18 6L6 18' : 'M4 7h16M4 12h16M4 17h16'} />
        </svg>
      </button>
      <ul id={listId} className="pas-nav__list m-0 flex list-none items-center gap-1 p-0">
        {items.map((item) => (
          <li key={item.href}>
            <a
              href={item.href}
              aria-current={item.href === current ? 'page' : undefined}
              className="pas-nav__link inline-flex min-h-11 items-center gap-1.5 rounded-[10px] px-3 text-sm font-semibold whitespace-nowrap text-[var(--muted)] no-underline hover:text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] aria-[current=page]:text-[var(--accent)]"
              onClick={(e) => follow(e, item.href)}
            >
              {item.icon}
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
