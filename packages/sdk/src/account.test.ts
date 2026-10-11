import { describe, it, expect, vi } from 'vitest';
import { Account } from './account.js';

function accountWith(status: number, user: { id: string } | null = { id: 'gh:1' }) {
  const calls: string[] = [];
  const authenticatedFetch = vi.fn(async (url: URL, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url.toString()}`);
    return Response.json({ deleted: true, files: [] }, { status });
  });
  const signOut = vi.fn(() => { calls.push('signOut'); });
  const auth = { user, authenticatedFetch, signOut, handleUnauthorized: vi.fn() };
  return { account: new Account('stash', 'https://api.proappstore.online', auth as never), calls, signOut };
}

// #379: per-app deletion — the app's handler, then the platform for THIS app, then sign-out.
describe('Account.delete', () => {
  it('runs the app handler, then deletes this app\'s platform data for the user, then signs out', async () => {
    const { account, calls } = accountWith(200);
    account.onDelete(async () => { calls.push('handler'); });
    await account.delete();
    expect(calls).toEqual([
      'handler',
      'DELETE https://api.proappstore.online/v1/apps/stash/users/gh%3A1/account',
      'signOut',
    ]);
  });

  it('stops before the platform deletes anything when the app handler fails', async () => {
    const { account, calls } = accountWith(200);
    account.onDelete(() => { throw new Error('a file could not be deleted'); });
    await expect(account.delete()).rejects.toThrow('a file could not be deleted');
    expect(calls).toEqual([]);
  });

  it('does not sign out when the platform refuses', async () => {
    const { account, signOut } = accountWith(500);
    await expect(account.delete()).rejects.toThrow('account.delete failed: 500');
    expect(signOut).not.toHaveBeenCalled();
  });

  it('unregistering a handler leaves no handler behind', async () => {
    const { account, calls } = accountWith(200);
    const off = account.onDelete(() => { calls.push('handler'); });
    off();
    await account.delete();
    expect(calls).not.toContain('handler');
  });

  it('refuses when nobody is signed in', async () => {
    await expect(accountWith(200, null).account.delete()).rejects.toThrow('Not signed in.');
  });
});

describe('Account reads', () => {
  it('isDeleted and publicFiles address the signed-in user in this app', async () => {
    const { account, calls } = accountWith(200);
    expect(await account.isDeleted()).toBe(true);
    expect(await account.publicFiles()).toEqual([]);
    expect(calls).toEqual([
      'GET https://api.proappstore.online/v1/apps/stash/users/gh%3A1/account',
      'GET https://api.proappstore.online/v1/apps/stash/users/gh%3A1/public-files',
    ]);
  });
});
