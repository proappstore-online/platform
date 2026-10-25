import { describe, expect, it } from 'vitest';
import { deleteProjectFiles, getProjectFile, listProjectFiles, requireParked, syncFromGitHub, writeProjectFiles } from './project-workspace.ts';
import { loadFiles } from './project-store.ts';
import { fakeHost, req, seedProject } from './project-test-host.ts';

const write = (files: unknown) => req('/files', { method: 'POST', body: { files } });

describe('direct file edits', () => {
  it('refuse to run while the project is running', async () => {
    const { host, db } = fakeHost();
    seedProject(db, { status: 'running' });
    expect(requireParked(host)?.status).toBe(409);
    expect((await writeProjectFiles(host, write([{ path: 'a.ts', content: 'x' }]))).status).toBe(409);
    expect((await deleteProjectFiles(host, req('/files', { method: 'DELETE', body: { paths: ['a.ts'] } }))).status).toBe(409);
  });

  it('write, list, read and delete the shared tree', async () => {
    const { host, db, broadcasts, activity } = fakeHost();
    seedProject(db);
    const res = await writeProjectFiles(host, write([{ path: 'src/a.ts', content: 'A' }, { path: 'b.md', content: 'BB' }]));
    expect(await res.json()).toEqual({ ok: true, written: 2, totalFiles: 2 });
    expect([...loadFiles(host.state.storage.sql).keys()].sort()).toEqual(['b.md', 'src/a.ts']);
    expect(broadcasts).toContainEqual({ type: 'files-synced', count: 2 });
    expect(activity[0]).toMatchObject({ type: 'tool', detail: 'Direct write: 2 file(s) — src/a.ts, b.md' });

    const { files } = (await listProjectFiles(host).json()) as { files: { path: string; size: number }[] };
    expect(files.map((f) => [f.path, f.size])).toEqual([['b.md', 2], ['src/a.ts', 1]]);
    expect(await getProjectFile(host, 'src/a.ts').json()).toEqual({ path: 'src/a.ts', content: 'A', truncated: false });
    expect(getProjectFile(host, '').status).toBe(400);
    expect(getProjectFile(host, 'missing').status).toBe(404);

    const del = await deleteProjectFiles(host, req('/files', { method: 'DELETE', body: { paths: ['b.md', 'gone'] } }));
    expect(await del.json()).toEqual({ ok: true, deleted: 1, totalFiles: 1 });
  });

  it('reject traversal, absolute paths and malformed entries', async () => {
    const { host, db } = fakeHost();
    seedProject(db);
    for (const bad of [[{ path: '../x', content: 'c' }], [{ path: '/etc/passwd', content: 'c' }], [{ path: 'a', content: 1 }], []]) {
      expect((await writeProjectFiles(host, write(bad))).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await writeProjectFiles(host, write(Array.from({ length: 201 }, (_, i) => ({ path: `f${i}`, content: '' }))))).status).toBe(413);
  });

  it('truncate a file over 200 KB when read for preview', async () => {
    const { host, db } = fakeHost();
    seedProject(db);
    await writeProjectFiles(host, write([{ path: 'big.txt', content: 'x'.repeat(200_001) }]));
    const body = (await getProjectFile(host, 'big.txt').json()) as { content: string; truncated: boolean };
    expect(body.truncated).toBe(true);
    expect(body.content).toHaveLength(200_000);
  });
});

describe('syncFromGitHub', () => {
  it('does nothing without the admin binding', async () => {
    const { host, db } = fakeHost();
    seedProject(db);
    expect(await syncFromGitHub(host, 'test')).toEqual({ pulled: false });
  });

  it('pulls the tree only when GitHub moved past the last-synced sha', async () => {
    const calls: { headOnly: boolean }[] = [];
    const ADMIN = { fetch: async (r: Request) => {
      const { headOnly } = (await r.json()) as { headOnly: boolean };
      calls.push({ headOnly });
      return Response.json(headOnly ? { ok: true, sha: 'abc1234567' } : { ok: true, sha: 'abc1234567', files: { 'README.md': '# hi' } });
    } };
    const { host, db, broadcasts } = fakeHost({ ADMIN, INTERNAL_TOKEN: 't' });
    seedProject(db);
    expect(await syncFromGitHub(host, 'manual')).toEqual({ pulled: true, count: 1 });
    expect(loadFiles(host.state.storage.sql).get('README.md')).toBe('# hi');
    expect(broadcasts).toContainEqual({ type: 'files-synced', count: 1 });
    expect(calls).toEqual([{ headOnly: true }, { headOnly: false }]);

    // Same head again: only the cheap head probe, the tree is left alone.
    calls.length = 0;
    expect(await syncFromGitHub(host, 'manual')).toEqual({ pulled: false });
    expect(calls).toEqual([{ headOnly: true }]);
  });

  it('never throws when the admin worker fails', async () => {
    const { host, db } = fakeHost({ ADMIN: { fetch: async () => { throw new Error('down'); } }, INTERNAL_TOKEN: 't' });
    seedProject(db);
    expect(await syncFromGitHub(host, 'x')).toEqual({ pulled: false });
  });
});
