import { describe, expect, it } from 'vitest';
import { assertAccess, assertRole, callerRole, helloFrame } from './project-access.ts';
import { OWNER, fakeHost, req, seedProject } from './project-test-host.ts';

describe('assertAccess', () => {
  it('refuses a request with no user id', () => {
    const { host } = fakeHost();
    const res = assertAccess(host, new Request('http://do/project'));
    expect(res?.status).toBe(403);
  });

  it('lets any user through before the project exists (ownership is set at init)', () => {
    const { host } = fakeHost();
    expect(assertAccess(host, req('/project', { headers: { 'X-User-Id': 'gh:anyone' } }))).toBeNull();
  });

  it('lets the owner and a known team role through, and hides the project from everyone else', async () => {
    const { host, db } = fakeHost();
    seedProject(db);
    expect(assertAccess(host, req('/project'))).toBeNull();
    expect(assertAccess(host, req('/project', { headers: { 'X-User-Id': 'gh:m', 'X-Team-Role': 'developer' } }))).toBeNull();
    const stranger = assertAccess(host, req('/project', { headers: { 'X-User-Id': 'gh:x' } }));
    expect(stranger?.status).toBe(404);
    expect(await stranger!.json()).toEqual({ error: 'not_found' });
    // A header that is present but not a known role is not membership.
    expect(assertAccess(host, req('/project', { headers: { 'X-User-Id': 'gh:x', 'X-Team-Role': 'root' } }))?.status).toBe(404);
  });
});

describe('callerRole / assertRole', () => {
  it('resolves owner, the forwarded team role, else viewer', () => {
    const { host, db } = fakeHost();
    seedProject(db);
    expect(callerRole(host, req('/x'))).toBe('owner');
    expect(callerRole(host, req('/x', { headers: { 'X-User-Id': 'gh:m', 'X-Team-Role': 'developer' } }))).toBe('developer');
    expect(callerRole(host, req('/x', { headers: { 'X-User-Id': 'gh:m', 'X-Team-Role': 'nonsense' } }))).toBe('viewer');
  });

  it('gates privileged routes by role (#79)', async () => {
    const { host, db } = fakeHost();
    seedProject(db);
    const as = (role: string, method: string) => req('/x', { method, headers: { 'X-User-Id': 'gh:m', 'X-Team-Role': role } });
    expect(assertRole(host, as('viewer', 'GET'), '/tickets')).toBeNull();
    const denied = assertRole(host, as('viewer', 'POST'), '/tickets');
    expect(denied?.status).toBe(403);
    expect(await denied!.json()).toEqual({ error: 'forbidden', detail: "requires 'developer' role (you have 'viewer')" });
    expect(assertRole(host, as('developer', 'POST'), '/tickets')).toBeNull();
    expect(assertRole(host, as('developer', 'POST'), '/deploy')?.status).toBe(403);
    expect(assertRole(host, req('/x', { method: 'POST' }), '/deploy')).toBeNull(); // the owner
  });
});

describe('helloFrame', () => {
  it('reports no project before init', () => {
    const { host } = fakeHost();
    expect(helloFrame(host)).toMatchObject({ type: 'hello', project: null, sockets: 0, keepalive: { ping: 'ping', pong: 'pong' } });
  });

  it('reports the project once it exists, paused by default', () => {
    const { host, db } = fakeHost();
    seedProject(db);
    expect(helloFrame(host)).toMatchObject({ project: { slug: 'demo', name: 'Demo', status: 'paused' } });
    expect(OWNER).toBe('gh:owner');
  });
});
