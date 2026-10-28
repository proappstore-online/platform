import { describe, expect, it } from 'vitest';
import { hostAllowedForApp, isAllowedAppRedirectUrl } from './app-redirect.js';
import { mockD1, mockStmt } from '../test-helpers.js';

const dbWith = (domains: string[]) => mockD1(mockStmt({ all: { results: domains.map((domain) => ({ domain })) } })) as unknown as D1Database;

describe('app-scoped redirect validation (#507)', () => {
  it('matches the PAS subdomain exactly and a custom domain with its subdomains, not look-alikes', () => {
    const allowed = { exact: ['club.proappstore.online'], domains: ['chessclubs.online'] };
    for (const h of ['club.proappstore.online', 'chessclubs.online', 'www.chessclubs.online']) expect(hostAllowedForApp(h, allowed), h).toBe(true);
    for (const h of ['other.proappstore.online', 'proappstore.online', 'xchessclubs.online', 'chessclubs.online.evil.example']) expect(hostAllowedForApp(h, allowed), h).toBe(false);
  });
  it('requires https except on localhost, and refuses credentials and non-URLs', async () => {
    expect(await isAllowedAppRedirectUrl(dbWith([]), 'club', 'http://localhost:3000/x')).toBe(true);
    expect(await isAllowedAppRedirectUrl(dbWith([]), 'club', 'http://club.proappstore.online/x')).toBe(false);
    expect(await isAllowedAppRedirectUrl(dbWith([]), 'club', 'https://u:p@club.proappstore.online/x')).toBe(false);
    expect(await isAllowedAppRedirectUrl(dbWith([]), 'club', 42)).toBe(false);
    expect(await isAllowedAppRedirectUrl(dbWith([]), 'club', 'https://club.proappstore.online/x')).toBe(true);
  });
});
