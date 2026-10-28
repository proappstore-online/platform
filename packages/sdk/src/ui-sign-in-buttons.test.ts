import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProAppStore } from './index.js';
import { SignInButtons as ProSignInButtons, SignInButton as ProSignInButton } from './ui-pro-components.js';
import { SignInButtons as PrimitiveSignInButtons, SignInButton as PrimitiveSignInButton } from './ui-primitives.js';
import { GateScreen } from './ui-gate.js';
import { ProProfilePage } from './ui-profile-page.js';
import { useAuth } from './hooks.js';

// #489: the shell offers Google next to GitHub by default, and an app may narrow the list. Google and GitHub are separate accounts.

vi.mock('./provider.js', () => ({ resolveApp: (app?: ProAppStore) => app }));

const signIn = vi.fn();
const app = { auth: { signIn, status: 'signed-out', user: null, onStatus: () => () => undefined, init: async () => undefined } } as unknown as ProAppStore;

type ButtonEl = ReactElement<{ onClick: () => void; children: string }>;
type ButtonsEl = ReactElement<{ children: ReactElement<{ provider: string; label: string; app?: ProAppStore }>[] }>;

beforeEach(() => signIn.mockClear());

describe.each([
  ['pro', ProSignInButtons, ProSignInButton],
  ['primitive', PrimitiveSignInButtons, PrimitiveSignInButton],
] as const)('%s SignInButtons', (_name, SignInButtons, SignInButton) => {
  const buttons = (providers?: ('github' | 'google')[]) =>
    ((SignInButtons as unknown as (p: object) => ButtonsEl)({ app, ...(providers ? { providers } : {}) })).props.children;
  const click = (el: ReactElement<{ provider: string; label: string }>) =>
    ((SignInButton as unknown as (p: object) => ButtonEl)({ app, ...el.props })).props.onClick();

  it('offers GitHub and Google by default, GitHub first', () => {
    const els = buttons();
    expect(els.map((e) => e.props.label)).toEqual(['Sign in with GitHub', 'Sign in with Google']);
    expect(els.map((e) => e.props.provider)).toEqual(['github', 'google']);
  });

  it('each button signs in with its own provider', () => {
    const [github, google] = buttons();
    click(github!);
    expect(signIn).toHaveBeenLastCalledWith('github');
    click(google!);
    expect(signIn).toHaveBeenLastCalledWith('google');
    expect(signIn).toHaveBeenCalledTimes(2);
  });

  it("an app can narrow the list: providers={['github']} shows one button, and an order is kept", () => {
    expect(buttons(['github']).map((e) => e.props.provider)).toEqual(['github']);
    expect(buttons(['google']).map((e) => e.props.label)).toEqual(['Sign in with Google']);
    expect(buttons(['google', 'github']).map((e) => e.props.provider)).toEqual(['google', 'github']);
  });
});

describe('the signed-out screens', () => {
  const html = (el: ReactElement) => renderToStaticMarkup(el);

  it('GateScreen shows both buttons by default', () => {
    const out = html(createElement(GateScreen, { gate: 'signed-out', app }));
    expect(out).toContain('Sign in with GitHub');
    expect(out).toContain('Sign in with Google');
    expect(out.indexOf('Sign in with GitHub')).toBeLessThan(out.indexOf('Sign in with Google'));
  });

  it('GateScreen honours providers', () => {
    const out = html(createElement(GateScreen, { gate: 'signed-out', app, providers: ['github'] }));
    expect(out).toContain('Sign in with GitHub');
    expect(out).not.toContain('Google');
  });

  it('the profile page prompt offers both too, and honours providers', () => {
    const both = html(createElement(ProProfilePage, { app }));
    expect(both).toContain('Sign in with GitHub');
    expect(both).toContain('Sign in with Google');
    expect(html(createElement(ProProfilePage, { app, providers: ['google'] }))).not.toContain('GitHub');
  });
});

describe('useAuth().signIn', () => {
  const capture = () => {
    let signInFn!: (provider?: unknown) => void;
    const Probe = () => { signInFn = useAuth(app).signIn as (provider?: unknown) => void; return null; };
    renderToStaticMarkup(createElement(Probe));
    return signInFn;
  };

  it('signs in with the provider it is given, and with the default when it is given none', () => {
    const fn = capture();
    fn('google');
    expect(signIn).toHaveBeenLastCalledWith('google');
    fn();
    expect(signIn).toHaveBeenLastCalledWith(undefined);
  });

  it('ignores a click event, so onClick={signIn} still signs in with the default', () => {
    capture()({ type: 'click' });
    expect(signIn).toHaveBeenLastCalledWith(undefined);
  });
});
