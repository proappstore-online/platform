import { describe, expect, it } from 'vitest';
import { handleRequest } from './project-routes.ts';
import { OWNER, fakeHost, req, seedProject } from './project-test-host.ts';

const as = (role: string) => ({ 'X-User-Id': 'gh:member', 'X-Team-Role': role });

describe('handleRequest', () => {
  it('answers 404 for an unknown route', async () => {
    const { host, db } = fakeHost();
    seedProject(db);
    const res = await handleRequest(host, req('/nope'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });

  it('403s a request that carries no user id', async () => {
    const { host, db } = fakeHost();
    seedProject(db);
    expect((await handleRequest(host, new Request('http://do/project'))).status).toBe(403);
  });

  it('hides the project from a non-member', async () => {
    const { host, db } = fakeHost();
    seedProject(db);
    expect((await handleRequest(host, req('/project', { headers: { 'X-User-Id': 'gh:stranger' } }))).status).toBe(404);
  });

  it('serves GET /project to the owner', async () => {
    const { host, db } = fakeHost();
    seedProject(db);
    expect(await (await handleRequest(host, req('/project'))).json()).toMatchObject({ slug: 'demo', ownerId: OWNER });
  });

  it('lets the init route through before the project exists', async () => {
    const { host, db } = fakeHost();
    const res = await handleRequest(host, req('/project', { method: 'PUT', body: { name: 'N', slug: 's', ownerId: OWNER } }));
    expect(res.status).toBe(200);
    expect(db.prepare('SELECT slug FROM project').get()).toEqual({ slug: 's' });
  });

  it('enforces roles per route (#79): a viewer reads, a developer writes tickets, only the owner changes the budget', async () => {
    const { host, db } = fakeHost();
    seedProject(db);
    expect((await handleRequest(host, req('/tickets', { headers: as('viewer') }))).status).toBe(200);
    expect((await handleRequest(host, req('/tickets', { method: 'POST', headers: as('viewer'), body: { title: 't', rawIdea: 'i' } }))).status).toBe(403);
    expect((await handleRequest(host, req('/tickets', { method: 'POST', headers: as('developer'), body: { title: 't', rawIdea: 'i' } }))).status).toBe(201);
    expect((await handleRequest(host, req('/budget', { method: 'PUT', headers: as('developer'), body: { costCapMonthlyUsd: 10 } }))).status).toBe(403);
    expect((await handleRequest(host, req('/budget', { method: 'PUT', body: { costCapMonthlyUsd: 10 } }))).status).toBe(200);
  });

  it('routes ticket sub-resources by id', async () => {
    const { host, db } = fakeHost();
    seedProject(db);
    const created = (await (await handleRequest(host, req('/tickets', { method: 'POST', body: { title: 't', rawIdea: 'i' } }))).json()) as { id: string };
    expect(created.id).toMatch(/^[a-f0-9-]+$/);
    expect((await handleRequest(host, req(`/tickets/${created.id}`))).status).toBe(200);
    expect(await (await handleRequest(host, req(`/tickets/${created.id}/messages`))).json()).toEqual({ messages: [] });
    expect((await handleRequest(host, req(`/tickets/${created.id}`, { method: 'DELETE' }))).status).toBe(200);
    expect((await handleRequest(host, req(`/tickets/${created.id}`))).status).toBe(404);
  });

  it('routes memory, files, shares, activity and the play state', async () => {
    const { host, db } = fakeHost();
    seedProject(db);
    const call = (path: string, init?: Parameters<typeof req>[1]) => handleRequest(host, req(path, init));
    expect(await (await call('/memory', { method: 'POST', body: { key: 'k', value: 'v' } })).json()).toMatchObject({ memory: [{ key: 'k' }] });
    expect(await (await call('/memory')).json()).toMatchObject({ memory: [{ key: 'k' }] });
    expect((await call('/files', { method: 'POST', body: { files: [{ path: 'a.txt', content: 'a' }] } })).status).toBe(200);
    expect(await (await call('/files/content?path=a.txt')).json()).toMatchObject({ content: 'a' });
    expect((await call('/shares')).status).toBe(200);
    expect(await (await call('/activity')).json()).toHaveProperty('activity');
    expect(await (await call('/project/pause', { method: 'POST' })).json()).toEqual({ status: 'paused' });
    expect((await call('/chat/history?thread=build')).status).toBe(200);
  });

  it('serves a KB share link without any user id (the share id is the credential)', async () => {
    const { host, db } = fakeHost();
    seedProject(db);
    const res = await handleRequest(host, new Request('http://do/kb/share/unknown-id'));
    expect(res.status).toBe(404);
  });
});
