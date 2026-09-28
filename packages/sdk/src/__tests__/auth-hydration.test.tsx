// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Auth } from '../auth.js';
import { ProShell } from '../shell.js';
import { useAuth, useGate } from '../hooks.js';
import type { ProAppStore } from '../index.js';

/**
 * #241: a signed-in refresh must never show the signed-out / sign-in UI while
 * the session check is unresolved. The real Auth, in platform-cookie mode with
 * `/.pas/auth/me` held open under test control, and in legacy-bearer mode.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const USER = { id: 'gh:1', name: 'Ada', login: 'ada', avatarUrl: null };
const SIGN_IN = 'Sign in to your ProAppStore account';

/** `/.pas/auth/me` held until the test answers it (a fresh response per call); every other request succeeds quietly. */
function holdMe() {
  let answer!: (outcome: 'in' | 'out' | 'down') => void;
  const settled = new Promise<'in' | 'out' | 'down'>((resolve) => { answer = resolve; });
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (!String(input).endsWith('/.pas/auth/me')) return new Response('{}', { status: 200 });
    const outcome = await settled;
    if (outcome === 'down') throw new Error('offline');
    return outcome === 'in' ? Response.json(USER) : new Response('unauthorized', { status: 401 });
  });
  vi.stubGlobal('fetch', fetchMock);
  const settle = (outcome: 'in' | 'out' | 'down') => act(async () => { answer(outcome); await settled; await new Promise((r) => setTimeout(r, 0)); });
  return {
    fetchMock,
    signedIn: () => settle('in'),
    signedOut: () => settle('out'),
    networkDown: () => settle('down'),
    meCalls: () => fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/.pas/auth/me')).length,
  };
}

/** A ProShell-ready app around a real Auth. */
function appWith(auth: Auth): ProAppStore {
  return {
    appId: 'demo',
    auth,
    subscription: { status: async () => ({ status: 'active' }) },
    logs: { capture: vi.fn() },
  } as unknown as ProAppStore;
}

let container: HTMLDivElement;
let root: Root;
let frames: string[];
let observer: MutationObserver;

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  localStorage.clear();
  // No request may leave the test: a cached session fires ensure-member at construction.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // Record every DOM state the user could have seen, not just the last one.
  frames = [];
  observer = new MutationObserver(() => frames.push(container.textContent ?? ''));
  observer.observe(container, { childList: true, subtree: true, characterData: true });
});
afterEach(() => {
  observer.disconnect();
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const render = (node: React.ReactNode) => act(async () => { root.render(node); });
const text = () => container.textContent ?? '';

describe('Auth status (#241)', () => {
  it('platform cookie: pending until /me answers — onChange(null) is not "signed out" — then signed-in', async () => {
    const me = holdMe();
    const auth = new Auth('demo', 'https://api.test', 'platform-cookie');
    const seen: string[] = [];
    auth.onChange((u) => seen.push(u ? 'user' : 'null'));
    auth.onStatus((s) => seen.push(s));
    expect(auth.status).toBe('pending');
    expect(seen).toEqual(['null', 'pending']); // the legacy null replay still happens; the status says why
    const done = auth.init();
    expect(auth.status).toBe('pending');
    await me.signedIn();
    await done;
    expect(auth.status).toBe('signed-in');
    expect(seen.at(-1)).toBe('signed-in');
  });

  it('platform cookie: a 401 or a network failure resolves to signed-out', async () => {
    for (const outcome of ['signedOut', 'networkDown'] as const) {
      const me = holdMe();
      const auth = new Auth('demo', 'https://api.test', 'platform-cookie');
      const statuses: string[] = [];
      auth.onStatus((s) => statuses.push(s));
      const done = auth.init();
      await me[outcome]();
      await done;
      expect(auth.status, outcome).toBe('signed-out');
      expect(statuses.at(-1), outcome).toBe('signed-out');
      expect(statuses, outcome).not.toContain('signed-in');
    }
  });

  it('the session check runs once per page: concurrent and later init() calls do not repeat it', async () => {
    const me = holdMe();
    const auth = new Auth('demo', 'https://api.test', 'platform-cookie');
    const all = Promise.all([auth.init(), auth.init(), auth.init()]);
    await me.signedIn();
    await all;
    await auth.init(); // a component mounting mid-session
    expect(me.meCalls()).toBe(1);
    expect(auth.status).toBe('signed-in');
  });

  it('a later init() still acts on a new sign-in callback in the URL', async () => {
    const fetchMock = vi.fn(async () => Response.json(USER));
    vi.stubGlobal('fetch', fetchMock);
    localStorage.setItem('pas:session', JSON.stringify({ token: 'old', user: { ...USER, login: 'other' } }));
    const auth = new Auth('demo', 'https://api.test', 'legacy-bearer');
    await auth.init();
    window.history.replaceState(null, '', '/inbox#pas_session=new-token');
    await auth.init();
    expect(auth.user?.login).toBe('ada');
    expect(auth.token).toBe('new-token');
    expect(location.hash).toBe('');
    expect(location.pathname).toBe('/inbox');
  });

  it('legacy bearer: a cached session is signed-in at once; none is pending until init, then signed-out', async () => {
    localStorage.setItem('pas:session', JSON.stringify({ token: 't', user: USER }));
    expect(new Auth('demo', 'https://api.test', 'legacy-bearer').status).toBe('signed-in');
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
    const auth = new Auth('demo', 'https://api.test', 'legacy-bearer');
    expect(auth.status).toBe('pending');
    await auth.init();
    expect(auth.status).toBe('signed-out');
  });

  it('legacy bearer: a token-only restore stays pending until the user is fetched', async () => {
    localStorage.setItem('pas:session', JSON.stringify({ token: 't' }));
    let answer!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((r) => { answer = r; })));
    const auth = new Auth('demo', 'https://api.test', 'legacy-bearer');
    expect(auth.status).toBe('pending');
    const done = auth.init();
    await Promise.resolve();
    expect(auth.status).toBe('pending');
    answer(Response.json(USER));
    await done;
    expect(auth.status).toBe('signed-in');
  });

  it('an expired session (a 401) and a real sign-out are signed-out immediately', async () => {
    localStorage.setItem('pas:session', JSON.stringify({ token: 't', user: USER }));
    const auth = new Auth('demo', 'https://api.test', 'legacy-bearer');
    const statuses: string[] = [];
    auth.onStatus((s) => statuses.push(s));
    auth.handleUnauthorized();
    expect(auth.status).toBe('signed-out');
    expect(statuses).toEqual(['signed-in', 'signed-out']);
    // Even before init() has settled, an explicit sign-out is an answer.
    holdMe();
    const pending = new Auth('demo', 'https://api.test', 'platform-cookie');
    pending.signOut();
    expect(pending.status).toBe('signed-out');
  });
});

describe('ProShell while auth resolves (#241)', () => {
  it('REGRESSION: a signed-in refresh never shows the sign-in screen — neutral loading, then the page', async () => {
    const me = holdMe();
    await render(<ProShell app={appWith(new Auth('demo', 'https://api.test', 'platform-cookie'))} appName="Demo"><p>the page</p></ProShell>);
    expect(text()).toContain('Loading...');
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Loading...');
    expect(text()).not.toContain(SIGN_IN);
    await me.signedIn();
    await act(async () => { await Promise.resolve(); });
    expect(text()).toContain('the page');
    expect(frames.some((f) => f.includes(SIGN_IN))).toBe(false);
    expect(frames.some((f) => f.includes('the page'))).toBe(true);
  });

  it('a genuinely signed-out user reaches the sign-in screen as soon as auth resolves', async () => {
    const me = holdMe();
    await render(<ProShell app={appWith(new Auth('demo', 'https://api.test', 'platform-cookie'))} appName="Demo"><p>the page</p></ProShell>);
    expect(text()).not.toContain(SIGN_IN);
    await me.signedOut();
    expect(text()).toContain(SIGN_IN);
    expect(frames.some((f) => f.includes('the page'))).toBe(false);
  });

  it('an expired session signs the user out of the shell promptly', async () => {
    localStorage.setItem('pas:session', JSON.stringify({ token: 't', user: USER }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
    const auth = new Auth('demo', 'https://api.test', 'legacy-bearer');
    await render(<ProShell app={appWith(auth)} appName="Demo"><p>the page</p></ProShell>);
    await act(async () => { await Promise.resolve(); });
    expect(text()).toContain('the page');
    await act(async () => { auth.handleUnauthorized(); });
    expect(text()).toContain(SIGN_IN);
    expect(text()).not.toContain('the page');
  });

  it('renderLoading replaces the neutral state while auth is pending', async () => {
    holdMe();
    await render(<ProShell app={appWith(new Auth('demo', 'https://api.test', 'platform-cookie'))} renderLoading={() => <p>skeleton</p>}><p>the page</p></ProShell>);
    expect(text()).toBe('skeleton');
  });

  it('keeps the deep link while pending, lands on it when signed in, and returns to it after signing in', async () => {
    window.history.replaceState(null, '', '/cases/42?tab=notes');
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
    const me = holdMe();
    await render(<ProShell app={appWith(new Auth('demo', 'https://api.test', 'platform-cookie'))}><p>case {location.pathname}{location.search}</p></ProShell>);
    expect(location.pathname + location.search).toBe('/cases/42?tab=notes'); // nothing navigated away while pending
    expect(assign).not.toHaveBeenCalled();
    await me.signedOut();
    act(() => { (container.querySelector('button') as HTMLButtonElement).click(); });
    const target = new URL(String(assign.mock.calls[0]![0]));
    expect(target.pathname).toBe('/.pas/auth/start');
    expect(target.searchParams.get('return_to')).toBe('/cases/42?tab=notes');

    act(() => root.unmount());
    root = createRoot(container);
    const again = holdMe();
    await render(<ProShell app={appWith(new Auth('demo', 'https://api.test', 'platform-cookie'))}><p>case {location.pathname}{location.search}</p></ProShell>);
    await again.signedIn();
    await act(async () => { await Promise.resolve(); });
    expect(text()).toContain('case /cases/42?tab=notes');
  });
});

describe('useAuth / useGate while auth resolves (#241)', () => {
  function Probe({ app }: { app: ProAppStore }) {
    const { status, loading, user } = useAuth(app);
    const { gate } = useGate(app);
    return <p>{`${status}|${String(loading)}|${user ? user.login : '-'}|${gate}`}</p>;
  }

  it('reports pending (loading, gate "loading") — never signed-out — until the session check answers', async () => {
    const me = holdMe();
    const app = appWith(new Auth('demo', 'https://api.test', 'platform-cookie'));
    await render(<Probe app={app} />);
    expect(text()).toBe('pending|true|-|loading');
    await me.signedIn();
    await act(async () => { await Promise.resolve(); });
    expect(text()).toBe('signed-in|false|ada|ready');
    expect(frames.some((f) => f.includes('signed-out'))).toBe(false);
  });

  it('a component mounted after auth resolved starts resolved, with no loading frame', async () => {
    const me = holdMe();
    const auth = new Auth('demo', 'https://api.test', 'platform-cookie');
    const done = auth.init();
    await me.signedOut();
    await done;
    frames = [];
    await render(<Probe app={appWith(auth)} />);
    expect(text()).toBe('signed-out|false|-|signed-out');
    expect(frames.some((f) => f.includes('pending'))).toBe(false);
  });
});
