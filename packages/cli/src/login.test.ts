import { describe, expect, it } from 'vitest';
import { loginCommand, loginStartUrl, parseProvider } from './login.js';

// #489: `pas login --provider google|github`; GitHub stays the default. They are separate accounts.

describe('pas login --provider', () => {
  it('defaults to github, and accepts github and google in any case', () => {
    expect(parseProvider(undefined)).toBe('github');
    expect(parseProvider('github')).toBe('github');
    expect(parseProvider('google')).toBe('google');
    expect(parseProvider('Google')).toBe('google');
  });

  it('refuses anything else and names the choices', () => {
    expect(() => parseProvider('facebook')).toThrow('Unknown provider "facebook". Use one of: github, google.');
    expect(() => parseProvider('')).toThrow('Unknown provider');
    expect(() => parseProvider('../x')).toThrow('Unknown provider');
  });

  it('builds the start URL for the chosen provider, returning a one-time code to the local callback', () => {
    const cb = 'http://127.0.0.1:4567/callback';
    const github = loginStartUrl('https://api.proappstore.online', 'github', cb);
    expect(github.origin + github.pathname).toBe('https://api.proappstore.online/v1/auth/github/start');
    const google = loginStartUrl('https://api.proappstore.online', 'google', cb);
    expect(google.origin + google.pathname).toBe('https://api.proappstore.online/v1/auth/google/start');
    for (const u of [github, google]) {
      expect(u.searchParams.get('return_to')).toBe(cb);
      expect(u.searchParams.get('response_mode')).toBe('query');
    }
  });

  it('is on the command, defaulting to github', () => {
    const option = loginCommand.options.find((o) => o.long === '--provider');
    expect(option?.defaultValue).toBe('github');
    expect(loginCommand.description()).toBe('Sign in with GitHub or Google.');
  });
});
