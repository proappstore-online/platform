import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { ProAppStore } from './index.js';
import { SignInButton as ProSignInButton } from './ui-pro-components.js';
import { SignInButton as PrimitiveSignInButton } from './ui-primitives.js';

vi.mock('./provider.js', () => ({
  resolveApp: (app?: ProAppStore) => app,
}));

type ButtonElement = ReactElement<{ onClick: () => void }>;
type SignInButtonComponent = (props: {
  app: ProAppStore;
  provider?: 'github' | 'google';
}) => ButtonElement;

describe.each([
  ['pro', ProSignInButton],
  ['primitive', PrimitiveSignInButton],
] as const)('%s SignInButton', (_name, SignInButton) => {
  const signIn = vi.fn();
  const app = { auth: { signIn } } as unknown as ProAppStore;
  const renderButton = SignInButton as SignInButtonComponent;

  beforeEach(() => {
    signIn.mockClear();
  });

  it('forwards GitHub as the default provider', () => {
    renderButton({ app }).props.onClick();

    expect(signIn).toHaveBeenCalledOnce();
    expect(signIn).toHaveBeenCalledWith('github');
  });

  it('forwards an explicit Google provider', () => {
    renderButton({ app, provider: 'google' }).props.onClick();

    expect(signIn).toHaveBeenCalledOnce();
    expect(signIn).toHaveBeenCalledWith('google');
  });
});
