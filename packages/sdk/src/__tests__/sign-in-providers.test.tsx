// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GateScreen } from '../ui-gate.js';
import { AppShell } from '../shell.js';
import { ProProfilePage } from '../ui-profile-page.js';
import { SignInButton } from '../ui-pro-components.js';
import type { ProAppStore } from '../index.js';

/**
 * #489: the signed-out gate and profile page offer "Sign in with GitHub" and
 * "Sign in with Google" by default, each calling signIn(<that provider>). An app
 * narrows the list with `providers`. GitHub and Google stay separate accounts.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
const signIn = vi.fn();
// A signed-out app: enough of the SDK surface for the gate, the profile page and their hooks.
const app = {
  auth: {
    status: 'signed-out',
    user: null,
    signIn,
    onStatus: (listener: (status: string, u: unknown) => void) => { listener('signed-out', null); return () => {}; },
    init: async () => {},
  },
  subscription: { get: async () => null, onChange: () => () => {} },
} as unknown as ProAppStore;

beforeEach(() => {
  signIn.mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const buttons = () => [...host.querySelectorAll('button')].map((b) => b.textContent);
const click = (label: string) => {
  const b = [...host.querySelectorAll('button')].find((x) => x.textContent === label)!;
  act(() => b.click());
};

describe('GateScreen sign-in', () => {
  it('offers GitHub and Google by default, each calling signIn with its own provider', () => {
    act(() => root.render(<GateScreen gate="signed-out" app={app} />));
    expect(buttons()).toEqual(['Sign in with GitHub', 'Sign in with Google']);
    click('Sign in with Google');
    expect(signIn).toHaveBeenLastCalledWith('google');
    click('Sign in with GitHub');
    expect(signIn).toHaveBeenLastCalledWith('github');
  });

  it("an app can narrow it: providers={['github']} shows GitHub only", () => {
    act(() => root.render(<GateScreen gate="signed-out" app={app} providers={['github']} />));
    expect(buttons()).toEqual(['Sign in with GitHub']);
  });

  it('keeps the order the app gives', () => {
    act(() => root.render(<GateScreen gate="signed-out" app={app} providers={['google', 'github']} />));
    expect(buttons()).toEqual(['Sign in with Google', 'Sign in with GitHub']);
  });
});

describe('ProProfilePage signed out', () => {
  it('offers both providers by default and honours providers', () => {
    act(() => root.render(<ProProfilePage app={app} />));
    expect(buttons()).toEqual(['Sign in with GitHub', 'Sign in with Google']);
    act(() => root.render(<ProProfilePage app={app} providers={['google']} />));
    expect(buttons()).toEqual(['Sign in with Google']);
  });
});

describe('SignInButton label', () => {
  it('follows the provider unless a label is given', () => {
    act(() => root.render(<><SignInButton app={app} provider="google" /><SignInButton app={app} label="Continue" /></>));
    expect(buttons()).toEqual(['Sign in with Google', 'Continue']);
  });
});

describe('AppShell sign-in gate', () => {
  it('shows GitHub + Google when signed out, and passes `providers` through', async () => {
    await act(async () => root.render(<AppShell app={app}>content</AppShell>));
    expect(buttons()).toEqual(['Sign in with GitHub', 'Sign in with Google']);
    await act(async () => root.render(<AppShell app={app} providers={['github']}>content</AppShell>));
    expect(buttons()).toEqual(['Sign in with GitHub']);
  });
});
