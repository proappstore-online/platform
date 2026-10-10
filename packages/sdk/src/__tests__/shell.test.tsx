// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activeHref, NavBar, type NavItem } from '../navbar.js';
import { NAVBAR_CSS } from '../navbar-css.js';
import { ProShell } from '../shell.js';
import { SHELL_CSS } from '../shell-css.js';
import type { ProAppStore } from '../index.js';

/**
 * #235: ProShell renders the app's main navigation from its `nav` prop — a
 * `<nav aria-label="Main">` landmark with the current route marked — and a
 * shell given no `nav` renders exactly as before.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ITEMS: NavItem[] = [
  { label: 'Home', href: '/' },
  { label: 'Cases', href: '/cases' },
  { label: 'Settings', href: '/settings' },
];

describe('NavBar markup', () => {
  it('renders a <nav aria-label="Main"> landmark with one link per item', () => {
    const html = renderToStaticMarkup(<NavBar items={ITEMS} currentPath="/" />);
    expect(html).toMatch(/^<nav aria-label="Main"/);
    expect(html.match(/<a /g)).toHaveLength(3);
    expect(html).toContain('href="/cases"');
  });

  it('marks exactly the current item with aria-current="page", matching nested routes to their section', () => {
    const current = (path: string) => {
      const html = renderToStaticMarkup(<NavBar items={ITEMS} currentPath={path} />);
      return [...html.matchAll(/<a href="([^"]+)" aria-current="page"/g)].map((m) => m[1]);
    };
    expect(current('/')).toEqual(['/']);
    expect(current('/cases')).toEqual(['/cases']);
    expect(current('/cases/42')).toEqual(['/cases']);
    expect(current('/casesx')).toEqual([]);
    expect(current('/unknown')).toEqual([]);
  });

  it('has a labelled menu button that controls the list, collapsed by default', () => {
    const html = renderToStaticMarkup(<NavBar items={ITEMS} currentPath="/" />);
    const controls = /aria-expanded="false" aria-controls="([^"]+)" aria-label="Menu"/.exec(html);
    expect(controls).not.toBeNull();
    expect(html).toContain(`<ul id="${controls![1]}"`);
    expect(html).toContain('data-open="false"');
  });

  it('renders nothing when there are no items (backward compatible)', () => {
    expect(renderToStaticMarkup(<NavBar items={[]} />)).toBe('');
  });

  it('ships 44 px targets, visible focus and the small-screen collapse in its CSS', () => {
    expect(NAVBAR_CSS).toContain('min-height:44px');
    expect(NAVBAR_CSS).toContain(':focus-visible');
    expect(NAVBAR_CSS).toContain('@media (max-width:639px)');
    expect(NAVBAR_CSS).not.toMatch(/#[0-9a-f]{3,6}\b/i); // tokens only (PAS-UI-001)
  });

  it('activeHref prefers the longest matching prefix and never matches "/" by prefix', () => {
    expect(activeHref([{ label: 'a', href: '/a' }, { label: 'ab', href: '/a/b' }], '/a/b/c')).toBe('/a/b');
    expect(activeHref(ITEMS, '/settings/profile')).toBe('/settings');
    expect(activeHref(ITEMS, '/x')).toBeNull();
  });
});

// ── mounted in a DOM ─────────────────────────────────────────────

/** An SDK instance that passes ProShell's gates: signed in, active subscription. */
function fakeApp(): ProAppStore {
  const user = { id: 'gh:1', name: 'Op', login: 'op', avatarUrl: null };
  return {
    appId: 'demo',
    auth: {
      user,
      status: 'signed-in',
      init: async () => {},
      onChange: () => () => {},
      onStatus: (listener: (status: string, u: unknown) => void) => { listener('signed-in', user); return () => {}; },
      signIn: () => {},
      signOut: async () => {},
    },
    subscription: { status: async () => ({ status: 'active' }) },
  } as unknown as ProAppStore;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function mount(node: React.ReactNode): Promise<void> {
  await act(async () => { root.render(node); });
  await act(async () => { await Promise.resolve(); });
}

describe('ProShell navigation (#235)', () => {
  it('REGRESSION: the default shell renders a <nav aria-label="Main"> in its topbar when nav items are supplied', async () => {
    window.history.replaceState(null, '', '/cases/7');
    await mount(<ProShell app={fakeApp()} appName="Demo" nav={ITEMS}><p>content</p></ProShell>);
    expect(container.textContent).toContain('content');
    const nav = container.querySelector('header nav[aria-label="Main"]');
    expect(nav).not.toBeNull();
    expect([...nav!.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['/', '/cases', '/settings']);
    expect(nav!.querySelector('[aria-current="page"]')?.getAttribute('href')).toBe('/cases');
    expect(document.getElementById('pas-nav-css')?.textContent).toBe(NAVBAR_CSS);
  });

  it('without nav, the default topbar is unchanged: no <nav> at all', async () => {
    await mount(<ProShell app={fakeApp()} appName="Demo"><p>content</p></ProShell>);
    expect(container.querySelector('header')).not.toBeNull();
    expect(container.querySelector('nav')).toBeNull();
  });

  it('REGRESSION: app-owned branding removes PAS advertising without removing navigation, profile, or text-size controls', async () => {
    await mount(<ProShell app={fakeApp()} appName="Independent" branding="app" nav={ITEMS}><p>content</p></ProShell>);
    expect(container.textContent).toContain('Independent');
    expect(container.textContent).not.toContain('ProAppStore');
    expect(container.querySelector('[href="https://proappstore.online"]')).toBeNull();
    expect(container.querySelector('footer.pas-footer')).toBeNull();
    expect(container.querySelector('header nav[aria-label="Main"]')).not.toBeNull();
    const textSize = container.querySelector('button[aria-label^="Text:"]') as HTMLButtonElement;
    expect(textSize).not.toBeNull();
    act(() => textSize.click());
    expect(document.documentElement.dataset.text).toBe('lg');
    const profile = container.querySelector('.pas-topbar__account > div > button') as HTMLButtonElement;
    expect(profile).not.toBeNull();
    act(() => profile.click());
    expect(container.textContent).toContain('Sign out');
  });

  it('keeps platform attribution as an explicit, backwards-compatible opt-in', async () => {
    await mount(<ProShell app={fakeApp()} appName="Demo" branding="platform"><p>content</p></ProShell>);
    expect(container.querySelector('[href="https://proappstore.online"]')?.textContent).toBe('Pro');
    expect(container.querySelector('footer.pas-footer')?.textContent).toContain('Part of');
  });

  it('hands the nav to a custom renderTopbar, and renderNav replaces the built-in NavBar', async () => {
    await mount(
      <ProShell app={fakeApp()} nav={ITEMS} renderTopbar={({ nav }) => <header className="custom">{nav}</header>}>
        <p />
      </ProShell>,
    );
    expect(container.querySelector('header.custom nav[aria-label="Main"]')).not.toBeNull();

    const onNavigate = vi.fn();
    await mount(
      <ProShell
        app={fakeApp()}
        nav={ITEMS}
        onNavigate={onNavigate}
        renderNav={({ items, currentPath, onNavigate: go }) => (
          <nav aria-label="Main" data-current={currentPath}>
            {items.map((i) => <button key={i.href} onClick={() => go(i.href)}>{i.label}</button>)}
          </nav>
        )}
      >
        <p />
      </ProShell>,
    );
    const custom = container.querySelector('header nav[aria-label="Main"]')!;
    expect(custom.getAttribute('data-current')).toBe('/');
    act(() => (custom.querySelectorAll('button')[1] as HTMLButtonElement).click());
    expect(onNavigate).toHaveBeenCalledWith('/cases');
    expect(container.querySelector('header nav')!.getAttribute('data-current')).toBe('/cases');
  });
});

describe('NavBar behaviour', () => {
  it('the menu button toggles aria-expanded; Escape closes it and returns focus to the button', async () => {
    await mount(<NavBar items={ITEMS} />);
    const toggle = container.querySelector('button[aria-controls]') as HTMLButtonElement;
    const nav = container.querySelector('nav')!;
    act(() => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(nav.getAttribute('data-open')).toBe('true');
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle);
  });

  it('with onNavigate, a plain click navigates client-side and moves aria-current; modified clicks are left to the browser', async () => {
    const onNavigate = vi.fn();
    await mount(<NavBar items={ITEMS} onNavigate={onNavigate} />);
    const cases = container.querySelector('a[href="/cases"]') as HTMLAnchorElement;
    const plain = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    act(() => { cases.dispatchEvent(plain); });
    expect(plain.defaultPrevented).toBe(true);
    expect(onNavigate).toHaveBeenCalledWith('/cases');
    expect(cases.getAttribute('aria-current')).toBe('page');

    const newTab = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, metaKey: true });
    act(() => { container.querySelector('a[href="/settings"]')!.dispatchEvent(newTab); });
    expect(newTab.defaultPrevented).toBe(false);
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it('follows back/forward (popstate) when no currentPath is given', async () => {
    await mount(<NavBar items={ITEMS} />);
    expect(container.querySelector('[aria-current="page"]')?.getAttribute('href')).toBe('/');
    act(() => {
      window.history.pushState(null, '', '/settings');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(container.querySelector('[aria-current="page"]')?.getAttribute('href')).toBe('/settings');
  });
});

describe('ProShell styling (#235): Tailwind + canonical tokens, no inline styles', () => {
  const FRAME: Array<[selector: string, cls: string, tailwind: string]> = [
    ['div.pas-shell', 'pas-shell', 'min-h-dvh'],
    ['header.pas-topbar', 'pas-topbar', 'bg-[var(--panel)]'],
    ['.pas-topbar__brand', 'pas-topbar__brand', 'gap-3'],
    ['a.pas-topbar__logo', 'pas-topbar__logo', 'text-[var(--accent)]'],
    ['span.pas-topbar__app', 'pas-topbar__app', 'text-[var(--muted)]'],
    ['.pas-topbar__account', 'pas-topbar__account', 'gap-2'],
    ['main.pas-main', 'pas-main', 'flex-1'],
    ['footer.pas-footer', 'pas-footer', 'border-[var(--line)]'],
    ['a.pas-footer__link', 'pas-footer__link', 'text-[var(--accent)]'],
  ];

  it('REGRESSION: the frame carries pas-* classes with Tailwind token utilities, and no style attributes', async () => {
    await mount(<ProShell app={fakeApp()} appName="Demo" nav={ITEMS}><p>content</p></ProShell>);
    for (const [selector, cls, tailwind] of FRAME) {
      const el = container.querySelector(selector);
      expect(el, selector).not.toBeNull();
      expect(el!.classList.contains(tailwind), `${cls} mirrors ${tailwind}`).toBe(true);
      expect(el!.hasAttribute('style'), `${cls} has an inline style`).toBe(false);
    }
    expect(container.querySelector('header nav[aria-label="Main"]')).not.toBeNull();
  });

  it('SHELL_CSS styles every frame class on the canonical tokens only', () => {
    for (const [, cls] of FRAME) expect(SHELL_CSS, cls).toMatch(new RegExp(`\\.${cls}\\{`));
    expect(SHELL_CSS).toContain('.pas-menu-item{');
    expect(SHELL_CSS).toContain('.pas-topbar{position:sticky;top:0');
    expect(SHELL_CSS).toContain('.pas-shell{display:flex;flex-direction:column;min-height:100dvh}');
    expect(SHELL_CSS).not.toMatch(/#[0-9a-f]{3,6}\b/i);
    expect(SHELL_CSS).not.toMatch(/\b100vh\b/);
    expect(SHELL_CSS).not.toMatch(/var\(--(bg|surface|border|glass|dock|error)\b/);
  });

  it('the shell source has no inline style objects left', () => {
    const src = readFileSync(join(__dirname, '..', 'shell.tsx'), 'utf8');
    expect(src).not.toMatch(/\bstyle=\{/);
    expect(src).not.toMatch(/CSSProperties/);
  });
});
