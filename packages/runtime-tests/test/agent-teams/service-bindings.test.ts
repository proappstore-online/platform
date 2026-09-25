import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { BASE, freshSlug, json, resetTables, session } from './helpers';

beforeEach(resetTables);

/**
 * The DO → ADMIN service-binding path (#23's "service-binding 401" bug class):
 * syncFromGitHub calls admin /api/repo-pull over the binding with the internal
 * token. The stub admin refuses a missing/wrong token, so a passing sync proves
 * the token travelled and the binding is wired.
 */
describe('ProjectDO → ADMIN service binding', () => {
  it('POST /sync pulls the working tree from admin repo-pull and mirrors it into the DO', async () => {
    const slug = freshSlug('sync');
    const owner = await session('gh:1', 'alice');
    expect((await SELF.fetch(`${BASE}/v1/projects`, json('POST', { name: 'Sync App', slug }, owner))).status).toBe(200);

    const sync = await SELF.fetch(`${BASE}/v1/projects/${slug}/sync`, json('POST', undefined, owner));
    expect(sync.status).toBe(200);
    expect(await sync.json()).toEqual({ ok: true, pulled: true, count: 2 });

    const files = await SELF.fetch(`${BASE}/v1/projects/${slug}/files`, json('GET', undefined, owner));
    const { files: tree } = (await files.json()) as { files: { path: string; size: number }[] };
    expect(tree.map((f) => f.path).sort()).toEqual(['index.html', 'src/app.ts']);
    const content = await SELF.fetch(`${BASE}/v1/projects/${slug}/files/content?path=index.html`, json('GET', undefined, owner));
    expect(await content.json()).toMatchObject({ content: '<h1>from github</h1>' });

    // Second sync: GitHub's HEAD equals the synced SHA, so nothing is pulled (mid-ticket edits are safe).
    const again = await SELF.fetch(`${BASE}/v1/projects/${slug}/sync`, json('POST', undefined, owner));
    expect(await again.json()).toEqual({ ok: true, pulled: false });
  });

  it('the PAS_BACKEND and KB bindings resolve to their workers (echo)', async () => {
    const api = await env.PAS_BACKEND.fetch('https://api.proappstore.online/v1/whatever', { headers: { 'X-Internal-Token': env.INTERNAL_TOKEN } });
    expect(await api.json()).toMatchObject({ worker: 'proappstore-api-echo', path: '/v1/whatever', headers: expect.objectContaining({ 'x-internal-token': env.INTERNAL_TOKEN }) });
    const kb = await env.KB.fetch('https://kb.proappstore.online/demo/.e2e/summary.json');
    expect(await kb.json()).toMatchObject({ worker: 'proappstore-kb-echo', path: '/demo/.e2e/summary.json' });
  });
});
