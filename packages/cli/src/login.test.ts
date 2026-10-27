import { describe, expect, it } from 'vitest';
import { loginCommand, loginStartUrl, parseProvider } from './login.js';

// #489: `pas login --provider google|github`. GitHub stays the default; Google is a
// separate account, started on the same backend route family.
describe('pas login --provider', () => {
  it('defaults to github', () => {
    expect(parseProvider(undefined)).toBe('github');
    expect(loginCommand.options.find((o) => o.long === '--provider')?.defaultValue).toBe('github');
  });

  it('accepts google and github, case-insensitively', () => {
    expect(parseProvider('google')).toBe('google');
    expect(parseProvider('GitHub')).toBe('github');
  });

  it('rejects anything else with a clear message', () => {
    expect(() => parseProvider('gitlab')).toThrow(/Use --provider github or --provider google/);
  });

  it('starts the matching provider route, returning to the loopback callback in query mode', () => {
    const google = loginStartUrl('https://api.proappstore.online', 'google', 'http://127.0.0.1:5000/callback');
    expect(google.origin + google.pathname).toBe('https://api.proappstore.online/v1/auth/google/start');
    expect(google.searchParams.get('return_to')).toBe('http://127.0.0.1:5000/callback');
    expect(google.searchParams.get('response_mode')).toBe('query');
    expect(loginStartUrl('https://api.proappstore.online', 'github', 'http://127.0.0.1:5000/callback').pathname).toBe('/v1/auth/github/start');
  });
});
