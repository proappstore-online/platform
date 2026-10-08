import { describe, expect, it, vi } from 'vitest';
import { Roles } from './roles.js';

/** #344: myRoles keeps resolving [] on failure by default; AdminConsole opts in to the error. */
const roles = (answer: () => Promise<Response>) =>
  new Roles('moder', 'https://api.proappstore.online', { authenticatedFetch: vi.fn(answer), handleUnauthorized: vi.fn() } as never);

describe('Roles.myRoles', () => {
  it("returns the caller's roles", async () => {
    expect(await roles(async () => Response.json({ roles: ['admin'] })).myRoles()).toEqual(['admin']);
    expect(await roles(async () => Response.json({ roles: [] })).myRoles({ throwOnError: true })).toEqual([]);
  });

  const failures: [string, () => Promise<Response>][] = [
    ['a network error', async () => { throw new TypeError('Failed to fetch'); }],
    ['a 5xx', async () => new Response('boom', { status: 503 })],
    ['a non-JSON body', async () => new Response('<html>', { status: 200 })],
    ['a body without roles', async () => Response.json({ error: 'x' })],
  ];

  it('resolves [] on a failure by default, as before', async () => {
    for (const [what, answer] of failures) expect(await roles(answer).myRoles(), what).toEqual([]);
  });

  it('rejects with throwOnError, so "no roles" and "could not ask" differ', async () => {
    for (const [what, answer] of failures) await expect(roles(answer).myRoles({ throwOnError: true }), what).rejects.toBeInstanceOf(Error);
  });
});
