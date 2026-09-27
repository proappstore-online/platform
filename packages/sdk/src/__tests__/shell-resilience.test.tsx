// @vitest-environment happy-dom
import { act, lazy, useEffect, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProShell } from '../shell.js';
import { SHELL_CSS } from '../shell-css.js';
import { PageHeader, useDocumentTitle } from '../page.js';
import { useToast, type ToastApi } from '../shell-resilience.js';
import type { NavItem } from '../navbar.js';
import type { ProAppStore } from '../index.js';

/**
 * #236 — ProShell's resilience and feedback layer: error boundary, Suspense
 * fallback, toast region, offline banner, route titles, PageHeader, skip link,
 * and scroll + focus handling on client-side route changes.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function fakeApp() {
  const capture = vi.fn();
  const app = {
    appId: 'demo',
    auth: {
      user: { id: 'gh:1', name: 'Op', login: 'op', avatarUrl: null },
      init: async () => {},
      onChange: () => () => {},
      signIn: () => {},
      signOut: async () => {},
    },
    subscription: { status: async () => ({ status: 'active' }) },
    logs: { capture },
  } as unknown as ProAppStore;
  return { app, capture };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  document.title = 'initial';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function mount(node: ReactNode): Promise<void> {
  await act(async () => { root.render(node); });
  await act(async () => { await Promise.resolve(); });
}
const nextFrame = () => act(async () => { await new Promise<void>((r) => requestAnimationFrame(() => r())); });
const quietConsoleErrors = () => vi.spyOn(console, 'error').mockImplementation(() => {});

// ── 1. Error boundary ──────────────────────────────────────────────

describe('error boundary', () => {
  it('shows the fallback instead of a white screen, keeps the chrome, and records the error via app.logs', async () => {
    quietConsoleErrors();
    const { app, capture } = fakeApp();
    function Boom(): ReactNode { throw new Error('kaboom'); }
    await mount(<ProShell app={app} appName="Demo"><Boom /></ProShell>);

    const alert = container.querySelector('main [role="alert"]');
    expect(alert?.querySelector('h1')?.textContent).toBe('Something went wrong');
    expect(alert?.querySelector('button')?.textContent).toBe('Try again');
    expect(container.querySelector('header')).not.toBeNull(); // chrome survives
    // describeError's format, the same as the automatic window.error capture.
    expect(capture).toHaveBeenCalledWith('error', 'react.error-boundary', 'Error: kaboom', expect.objectContaining({
      stack: expect.stringContaining('kaboom'),
      componentStack: expect.stringContaining('Boom'),
      path: '/',
    }));
  });

  it('"Try again" renders the screen again', async () => {
    quietConsoleErrors();
    let fail = true;
    function Flaky() {
      if (fail) throw new Error('once');
      return <p>recovered</p>;
    }
    await mount(<ProShell app={fakeApp().app}><Flaky /></ProShell>);
    fail = false;
    await act(async () => { (container.querySelector('[role="alert"] button') as HTMLButtonElement).click(); });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain('recovered');
  });

  it('renderError replaces the fallback and receives the error and a reset', async () => {
    quietConsoleErrors();
    let fail = true;
    function Flaky() {
      if (fail) throw new Error('custom');
      return <p>back</p>;
    }
    const renderError = vi.fn(({ error, reset }: { error: Error; reset: () => void }) => (
      <button type="button" onClick={reset}>Oops: {error.message}</button>
    ));
    await mount(<ProShell app={fakeApp().app} renderError={renderError}><Flaky /></ProShell>);
    const button = container.querySelector('main button') as HTMLButtonElement;
    expect(button.textContent).toBe('Oops: custom');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    fail = false;
    await act(async () => { button.click(); });
    expect(container.textContent).toContain('back');
  });

  it('navigating to another route clears the error', async () => {
    quietConsoleErrors();
    function Screens() {
      const path = usePath();
      if (path === '/broken') throw new Error('broken screen');
      return <p>fine at {path}</p>;
    }
    window.history.replaceState(null, '', '/broken');
    await mount(<ProShell app={fakeApp().app} nav={NAV} onNavigate={routerNavigate}><Screens /></ProShell>);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    await act(async () => { clickLink('/'); });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain('fine at /');
  });
});

// ── 2. Suspense ────────────────────────────────────────────────────

describe('Suspense fallback', () => {
  function lazyScreen() {
    let resolve!: (m: { default: () => ReactNode }) => void;
    const Screen = lazy(() => new Promise<{ default: () => ReactNode }>((r) => { resolve = r; }));
    return { Screen, load: () => act(async () => { resolve({ default: () => <p>loaded screen</p> }); }) };
  }

  it('shows the shell spinner while a lazy screen loads, then the screen', async () => {
    const { Screen, load } = lazyScreen();
    await mount(<ProShell app={fakeApp().app}><Screen /></ProShell>);
    const spinner = container.querySelector('main .pas-shell-loading [role="status"][aria-label="Loading"]');
    expect(spinner).not.toBeNull();
    await load();
    expect(container.querySelector('.pas-shell-loading')).toBeNull();
    expect(container.textContent).toContain('loaded screen');
  });

  it('renderLoading replaces the spinner', async () => {
    const { Screen } = lazyScreen();
    await mount(<ProShell app={fakeApp().app} renderLoading={() => <p className="mine">Loading cases…</p>}><Screen /></ProShell>);
    expect(container.querySelector('main p.mine')?.textContent).toBe('Loading cases…');
    expect(container.querySelector('.pas-shell-loading')).toBeNull();
  });
});

// ── 3. Toasts ──────────────────────────────────────────────────────

describe('useToast', () => {
  let toast: ToastApi;
  function Grab() {
    toast = useToast();
    return null;
  }
  const region = () => container.querySelectorAll('.pas-toast-region');
  const messages = () => [...container.querySelectorAll('.pas-toast-region .pas-toast span')].map((s) => s.textContent);

  it('mounts exactly one polite live region, present before any message, with no nested live regions', async () => {
    await mount(<ProShell app={fakeApp().app}><Grab /></ProShell>);
    expect(region()).toHaveLength(1);
    expect(region()[0]!.getAttribute('role')).toBe('status');
    expect(region()[0]!.getAttribute('aria-live')).toBe('polite');
    act(() => { toast.show('Saved', { variant: 'success' }); toast.show('Copied'); });
    expect(region()).toHaveLength(1);
    expect(messages()).toEqual(['Saved', 'Copied']);
    expect(region()[0]!.querySelectorAll('[role], [aria-live]')).toHaveLength(0);
    expect(region()[0]!.querySelector('.pas-toast')!.getAttribute('data-variant')).toBe('success');
  });

  it('queues: keeps the newest four, and a dismiss button removes one', async () => {
    await mount(<ProShell app={fakeApp().app}><Grab /></ProShell>);
    act(() => { for (let i = 1; i <= 6; i++) toast.show(`m${i}`, { duration: 0 }); });
    expect(messages()).toEqual(['m3', 'm4', 'm5', 'm6']);
    act(() => { (container.querySelector('.pas-toast button[aria-label="Dismiss"]') as HTMLButtonElement).click(); });
    expect(messages()).toEqual(['m4', 'm5', 'm6']);
  });

  it('auto-dismisses after its duration; duration 0 stays; dismiss(id) removes by id', async () => {
    await mount(<ProShell app={fakeApp().app}><Grab /></ProShell>);
    vi.useFakeTimers();
    let sticky = 0;
    act(() => { toast.show('brief'); sticky = toast.show('sticky', { duration: 0 }); toast.show('longer', { duration: 8000 }); });
    act(() => { vi.advanceTimersByTime(4000); });
    expect(messages()).toEqual(['sticky', 'longer']);
    act(() => { vi.advanceTimersByTime(4000); });
    expect(messages()).toEqual(['sticky']);
    act(() => { toast.dismiss(sticky); });
    expect(messages()).toEqual([]);
  });

  it('throws a clear error outside ProShell', () => {
    quietConsoleErrors();
    expect(() => renderToStaticMarkup(<Grab />)).toThrow('useToast must be used inside <ProShell>');
  });
});

// ── 4. Offline banner ──────────────────────────────────────────────

describe('offline banner', () => {
  let online = true;
  beforeEach(() => {
    online = true;
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => online });
  });
  afterEach(() => { online = true; }); // the getter outlives this block
  const banner = () => container.querySelector('.pas-offline');
  const go = (state: boolean) => act(() => {
    online = state;
    window.dispatchEvent(new Event(state ? 'online' : 'offline'));
  });

  it('appears in a polite live region when the connection drops and clears on reconnect', async () => {
    await mount(<ProShell app={fakeApp().app}><p /></ProShell>);
    expect(banner()).toBeNull();
    go(false);
    expect(banner()?.textContent).toContain("You're offline");
    const live = banner()!.parentElement!;
    expect(live.getAttribute('role')).toBe('status');
    expect(live.getAttribute('aria-live')).toBe('polite');
    go(true);
    expect(banner()).toBeNull();
  });

  it('is dismissible, and shows again on the next drop', async () => {
    await mount(<ProShell app={fakeApp().app}><p /></ProShell>);
    go(false);
    act(() => { (container.querySelector('button[aria-label="Dismiss offline notice"]') as HTMLButtonElement).click(); });
    expect(banner()).toBeNull();
    go(true);
    go(false);
    expect(banner()).not.toBeNull();
  });

  it('starts shown when the app loads offline', async () => {
    online = false;
    await mount(<ProShell app={fakeApp().app}><p /></ProShell>);
    expect(banner()).not.toBeNull();
  });
});

// ── test router: pushState + a notify event, as a router would ─────

const NAV: NavItem[] = [
  { label: 'Home', href: '/', title: 'Home — Demo' },
  { label: 'Cases', href: '/cases', title: 'Cases — Demo' },
  { label: 'About', href: '/about' },
];
function routerNavigate(href: string) {
  window.history.pushState(null, '', href);
  window.dispatchEvent(new Event('test-router'));
}
function usePath() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const sync = () => setPath(window.location.pathname);
    window.addEventListener('test-router', sync);
    window.addEventListener('popstate', sync);
    return () => {
      window.removeEventListener('test-router', sync);
      window.removeEventListener('popstate', sync);
    };
  }, []);
  return path;
}
function clickLink(href: string) {
  (container.querySelector(`header nav a[href="${href}"]`) as HTMLAnchorElement)
    .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
}
function historyGo(path: string) {
  window.history.replaceState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

// ── 5. Document title ──────────────────────────────────────────────

describe('document title', () => {
  it("applies the current nav item's title and follows client-side navigation", async () => {
    window.history.replaceState(null, '', '/cases');
    await mount(<ProShell app={fakeApp().app} nav={NAV} onNavigate={routerNavigate}><p /></ProShell>);
    expect(document.title).toBe('Cases — Demo');
    await act(async () => { clickLink('/'); });
    expect(document.title).toBe('Home — Demo');
    await act(async () => { historyGo('/cases'); });
    expect(document.title).toBe('Cases — Demo');
  });

  it("a screen's useDocumentTitle wins over the nav item's title, and tracks its value", async () => {
    function CaseScreen({ name }: { name: string }) {
      useDocumentTitle(`${name} — Cases`);
      return null;
    }
    window.history.replaceState(null, '', '/cases');
    await mount(<ProShell app={fakeApp().app} nav={NAV}><CaseScreen name="Case 42" /></ProShell>);
    expect(document.title).toBe('Case 42 — Cases');
    await mount(<ProShell app={fakeApp().app} nav={NAV}><CaseScreen name="Case 43" /></ProShell>);
    expect(document.title).toBe('Case 43 — Cases');
  });

  it('leaves the title alone when no item declares one (unchanged from #235)', async () => {
    window.history.replaceState(null, '', '/about');
    await mount(<ProShell app={fakeApp().app} nav={NAV}><p /></ProShell>);
    expect(document.title).toBe('initial');
  });
});

// ── 6. PageHeader ──────────────────────────────────────────────────

describe('PageHeader', () => {
  it("renders the screen's single h1, focusable for route focus, with optional description and actions", () => {
    const html = renderToStaticMarkup(<PageHeader title="Cases" description="Open support cases" actions={<button type="button">New case</button>} />);
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toMatch(/<h1 class="pas-page-header__title[^"]*" tabindex="-1" data-pas-page-heading="">Cases<\/h1>/);
    expect(html).toContain('<p class="pas-page-header__description');
    expect(html).toContain('>Open support cases</p>');
    expect(html).toContain('<button type="button">New case</button>');
  });

  it('renders no description or actions markup when none are given', () => {
    const html = renderToStaticMarkup(<PageHeader title="Home" />);
    expect(html).not.toContain('<p');
    expect(html).not.toContain('<button');
  });
});

// ── 7. Skip link ───────────────────────────────────────────────────

describe('skip link', () => {
  it('is the first focusable element and targets <main id="main">', async () => {
    await mount(<ProShell app={fakeApp().app} appName="Demo" nav={NAV}><p /></ProShell>);
    const focusable = container.querySelectorAll('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])');
    const first = focusable[0] as HTMLAnchorElement;
    expect(first.className).toBe('pas-skip-link');
    expect(first.getAttribute('href')).toBe('#main');
    expect(first.textContent).toBe('Skip to content');
    const main = container.querySelector('main#main') as HTMLElement;
    expect(main.getAttribute('tabindex')).toBe('-1');
  });

  it('activating it moves focus to main without a history navigation', async () => {
    await mount(<ProShell app={fakeApp().app}><p /></ProShell>);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    act(() => { container.querySelector('.pas-skip-link')!.dispatchEvent(click); });
    expect(click.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(container.querySelector('main#main'));
    expect(window.location.hash).toBe('');
  });

  it('is visually hidden until focused (injected shell CSS)', async () => {
    await mount(<ProShell app={fakeApp().app}><p /></ProShell>);
    expect(document.getElementById('pas-shell-css')?.textContent).toBe(SHELL_CSS);
    expect(SHELL_CSS).toContain('.pas-skip-link:not(:focus){position:absolute;width:1px;height:1px');
    expect(SHELL_CSS).toContain('clip-path:inset(50%)');
    expect(SHELL_CSS).toMatch(/\.pas-skip-link:focus\{position:fixed/);
    expect(SHELL_CSS).not.toMatch(/#[0-9a-f]{3,6}\b/i);
    // the design-system lint's banned aliases (scripts/check-design-system.sh)
    expect(SHELL_CSS).not.toMatch(/var\(--(bg|surface|border|glass|dock|error)\b/);
  });
});

// ── 8 + 9. Route changes: scroll restoration and focus ─────────────

describe('client-side route changes', () => {
  let scrollY = 0;
  let scrollTo: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    scrollY = 0;
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollY });
    scrollTo = vi.fn((_x: number, y: number) => { scrollY = y; });
    window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
  });

  function Screens() {
    const path = usePath();
    if (path === '/cases') return <><PageHeader title="Cases" /><p>list</p></>;
    return <p>home body</p>;
  }

  it('forward navigation lands at the top; back and forward restore where each route was left', async () => {
    await mount(<ProShell app={fakeApp().app} nav={NAV} onNavigate={routerNavigate}><Screens /></ProShell>);
    expect(window.history.scrollRestoration).toBe('manual');

    scrollY = 500;                                   // read down the home screen
    await act(async () => { clickLink('/cases'); });
    await nextFrame();
    expect(scrollTo).toHaveBeenLastCalledWith(0, 0); // forward → top

    scrollY = 120;                                   // read down the cases screen
    await act(async () => { historyGo('/'); });      // back
    await nextFrame();
    expect(scrollTo).toHaveBeenLastCalledWith(0, 500);

    await act(async () => { historyGo('/cases'); }); // forward
    await nextFrame();
    expect(scrollTo).toHaveBeenLastCalledWith(0, 120);
  });

  it("moves focus to the new screen's PageHeader h1, or to main when it has none", async () => {
    await mount(<ProShell app={fakeApp().app} nav={NAV} onNavigate={routerNavigate}><Screens /></ProShell>);
    const link = container.querySelector('header nav a[href="/cases"]') as HTMLAnchorElement;
    link.focus();
    await act(async () => { clickLink('/cases'); });
    await nextFrame();
    expect(document.activeElement?.tagName).toBe('H1');
    expect(document.activeElement?.textContent).toBe('Cases');

    await act(async () => { historyGo('/'); });
    await nextFrame();
    expect(document.activeElement).toBe(container.querySelector('main#main'));
  });

  it('does not scroll or move focus on the first render', async () => {
    window.history.replaceState(null, '', '/cases');
    await mount(<ProShell app={fakeApp().app} nav={NAV} onNavigate={routerNavigate}><Screens /></ProShell>);
    await nextFrame();
    expect(scrollTo).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);
  });

  it('with plain links (no onNavigate) it leaves scrolling and history.scrollRestoration to the browser', async () => {
    window.history.scrollRestoration = 'auto';
    await mount(<ProShell app={fakeApp().app} nav={NAV}><Screens /></ProShell>);
    expect(window.history.scrollRestoration).toBe('auto');
    await act(async () => { historyGo('/cases'); });
    await nextFrame();
    expect(scrollTo).not.toHaveBeenCalled();
  });
});

// ── unchanged when nothing is opted into ───────────────────────────

describe('an app opting into none of it', () => {
  it('renders its content in main with the existing chrome and no visible extras', async () => {
    await mount(<ProShell app={fakeApp().app} appName="Demo"><p>content</p></ProShell>);
    expect(container.querySelector('main#main')?.textContent).toBe('content');
    expect(container.querySelector('header')).not.toBeNull();
    expect(container.querySelector('footer')).not.toBeNull();
    expect(container.querySelector('nav')).toBeNull();
    expect(container.querySelector('.pas-offline, .pas-toast, [role="alert"], .pas-shell-loading')).toBeNull();
    expect(document.title).toBe('initial');
  });
});
