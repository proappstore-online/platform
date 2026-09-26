import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { app } from '../index.js';
import { testToken, TEST_SK, mockStmt, mockD1, makeEnv as sharedMakeEnv } from '../test-helpers.js';

const TOK = await testToken('gh:1');
const TOK_B = await testToken('gh:2');
const OUTSIDER = await testToken('gh:3');

function makeStorage(overrides: Partial<R2Bucket> = {}): R2Bucket {
  return {
    put: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue({ objects: [] }),
    head: vi.fn().mockResolvedValue(null),
    createMultipartUpload: vi.fn(),
    resumeMultipartUpload: vi.fn(),
    ...overrides,
  } as unknown as R2Bucket;
}

function makeEnv(overrides: Record<string, unknown> = {}, db?: ReturnType<typeof mockD1>) {
  return sharedMakeEnv({ STORAGE: makeStorage(), ...overrides }, db);
}

beforeEach(() => {
  globalThis.fetch = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({ id: 'gh:1', login: 'tester', avatarUrl: null, roles: ['user'], appRoles: {} }),
      { status: 200 },
    ),
  );
});
describe('PUT /v1/apps/:appId/storage/* — upload', () => {
  it('returns 401 without auth', async () => {
    const res = await app.request(
      '/v1/apps/myapp/storage/photo.png',
      {
        method: 'PUT',
        headers: { Authorization: 'Bearer bad', 'Content-Type': 'image/png' },
        body: new Uint8Array([1, 2, 3]),
      },
      makeEnv(),
    );
    expect(res.status).toBe(401);
  });

  it('returns 400 for text/html content type', async () => {
    const res = await app.request(
      '/v1/apps/myapp/storage/page.html',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'text/html' },
        body: new Uint8Array([60, 104, 116, 109, 108, 62]),
      },
      makeEnv(),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('content type not allowed');
  });

  it('returns 400 for application/javascript content type', async () => {
    const res = await app.request(
      '/v1/apps/myapp/storage/script.js',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/javascript' },
        body: new Uint8Array([97, 108, 101, 114, 116]),
      },
      makeEnv(),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('content type not allowed');
  });

  it('returns 400 for image/svg+xml content type', async () => {
    const res = await app.request(
      '/v1/apps/myapp/storage/image.svg',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'image/svg+xml' },
        body: new Uint8Array([60, 115, 118, 103, 62]),
      },
      makeEnv(),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('content type not allowed');
  });

  it('returns 400 for text/javascript content type', async () => {
    const res = await app.request(
      '/v1/apps/myapp/storage/code.js',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'text/javascript' },
        body: new Uint8Array([1]),
      },
      makeEnv(),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 for application/xhtml+xml content type', async () => {
    const res = await app.request(
      '/v1/apps/myapp/storage/doc.xhtml',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/xhtml+xml' },
        body: new Uint8Array([1]),
      },
      makeEnv(),
    );
    expect(res.status).toBe(400);
  });

  it('returns 200 for image/png', async () => {
    const storage = makeStorage();
    const res = await app.request(
      '/v1/apps/myapp/storage/photo.png',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'image/png' },
        body: new Uint8Array([137, 80, 78, 71]),
      },
      makeEnv({ STORAGE: storage }),
    );
    expect(res.status).toBe(200);
    const data = await res.json() as { key: string; size: number; contentType: string };
    expect(data.key).toBe('photo.png');
    expect(data.contentType).toBe('image/png');
    expect(storage.put).toHaveBeenCalledTimes(1);
  });

  it('returns 200 for application/pdf', async () => {
    const storage = makeStorage();
    const res = await app.request(
      '/v1/apps/myapp/storage/doc.pdf',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/pdf' },
        body: new Uint8Array([37, 80, 68, 70]),
      },
      makeEnv({ STORAGE: storage }),
    );
    expect(res.status).toBe(200);
    const data = await res.json() as { contentType: string };
    expect(data.contentType).toBe('application/pdf');
  });

  it('returns 200 for application/json', async () => {
    const storage = makeStorage();
    const res = await app.request(
      '/v1/apps/myapp/storage/data.json',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: new Uint8Array(Buffer.from('{"x":1}')),
      },
      makeEnv({ STORAGE: storage }),
    );
    expect(res.status).toBe(200);
    const data = await res.json() as { contentType: string };
    expect(data.contentType).toBe('application/json');
  });

  it('strips charset parameters from content-type before storing', async () => {
    const storage = makeStorage();
    const res = await app.request(
      '/v1/apps/myapp/storage/data.txt',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'text/plain; charset=utf-8' },
        body: new Uint8Array(Buffer.from('hello')),
      },
      makeEnv({ STORAGE: storage }),
    );
    expect(res.status).toBe(200);
    const data = await res.json() as { contentType: string };
    // charset parameter must be stripped
    expect(data.contentType).toBe('text/plain');
    expect(data.contentType).not.toContain('charset');

    const putCall = vi.mocked(storage.put).mock.calls[0];
    const putOpts = putCall[2] as { httpMetadata: { contentType: string } };
    expect(putOpts.httpMetadata.contentType).toBe('text/plain');
  });

  it('does not strip content type when no parameters present', async () => {
    const storage = makeStorage();
    const res = await app.request(
      '/v1/apps/myapp/storage/img.png',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'image/png' },
        body: new Uint8Array([1, 2, 3]),
      },
      makeEnv({ STORAGE: storage }),
    );
    expect(res.status).toBe(200);
    const data = await res.json() as { contentType: string };
    expect(data.contentType).toBe('image/png');
  });

  it('returns 400 for empty file', async () => {
    const res = await app.request(
      '/v1/apps/myapp/storage/empty.png',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'image/png' },
        body: new Uint8Array([]),
      },
      makeEnv(),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('empty file');
  });

  it('scopes uploaded file key under user id', async () => {
    const storage = makeStorage();
    await app.request(
      '/v1/apps/myapp/storage/notes/draft.txt',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'text/plain' },
        body: new Uint8Array(Buffer.from('draft')),
      },
      makeEnv({ STORAGE: storage }),
    );
    const putCall = vi.mocked(storage.put).mock.calls[0];
    const key = putCall[0] as string;
    expect(key).toBe('myapp/gh:1/notes/draft.txt');
  });

  it('uses _public prefix for public files when user is app owner', async () => {
    const storage = makeStorage();
    // requireAppOwner needs DB to return the app with matching creator_id
    const ownerStmt = mockStmt({ first: { creator_id: 'gh:1' } });
    const db = mockD1(ownerStmt);
    const res = await app.request(
      '/v1/apps/myapp/storage/_public/logo.png',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'image/png' },
        body: new Uint8Array([1, 2, 3]),
      },
      makeEnv({ STORAGE: storage }, db),
    );
    expect(res.status).toBe(200);
    const putCall = vi.mocked(storage.put).mock.calls[0]!;
    const key = putCall[0] as string;
    expect(key).toBe('myapp/_public/logo.png');
    expect(key).not.toContain('gh:1');
  });

  it('_userpub: any signed-in user (non-owner) uploads public content under their own id', async () => {
    const storage = makeStorage();
    // DB owner is someone else — proves this is NOT owner-gated (requireUser, not requireAppOwner).
    const db = mockD1(mockStmt({ first: { creator_id: 'someone-else' } }));
    const res = await app.request(
      '/v1/apps/myapp/storage/_userpub/ratings/abc/photo.jpg',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'image/jpeg' },
        body: new Uint8Array([1, 2, 3]),
      },
      makeEnv({ STORAGE: storage }, db),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { key: string };
    // server namespaces by the caller's id (from the token), publicUrl-ready
    expect(body.key).toBe('u/gh:1/ratings/abc/photo.jpg');
    const putKey = vi.mocked(storage.put).mock.calls[0]![0] as string;
    expect(putKey).toBe('myapp/_public/u/gh:1/ratings/abc/photo.jpg');
  });
});

// #207: DELETE mirrors the PUT namespacing, so user-public uploads can be removed
// by their uploader or taken down by the app team, and a wrong key is a 404.
describe('DELETE /v1/apps/:appId/storage/* — namespaced deletion (#207)', () => {

  /** An R2 fake with real state, so "deleted, then GET is 404" is observable. */
  function bucket(keys: string[]) {
    const objects = new Map(keys.map((k) => [k, new Uint8Array([1, 2, 3])]));
    const storage = makeStorage({
      head: vi.fn(async (key: string) => (objects.has(key) ? { key } : null)) as unknown as R2Bucket['head'],
      get: vi.fn(async (key: string) => {
        const bytes = objects.get(key);
        return bytes ? { body: bytes, httpEtag: '"e"', writeHttpMetadata: () => {} } : null;
      }) as unknown as R2Bucket['get'],
      delete: vi.fn(async (key: string) => { objects.delete(key); }) as unknown as R2Bucket['delete'],
    });
    return { storage, objects };
  }
  const del = (path: string, token: string, e: ReturnType<typeof makeEnv>) =>
    app.request(`/v1/apps/myapp/storage/${path}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }, e);
  const A_FILE = 'myapp/_public/u/gh:1/p/1.jpg';

  it('lets the uploader delete their own user-public file, which is then gone from the public URL', async () => {
    const { storage, objects } = bucket([A_FILE]);
    const e = makeEnv({ STORAGE: storage });
    expect((await app.request('/v1/apps/myapp/public/u/gh:1/p/1.jpg', {}, e)).status).toBe(200);

    expect((await del('_userpub/p/1.jpg', TOK, e)).status).toBe(204);
    expect(objects.has(A_FILE)).toBe(false);
    expect((await app.request('/v1/apps/myapp/public/u/gh:1/p/1.jpg', {}, e)).status).toBe(404);
  });

  it('scopes _userpub deletion to the caller: user B addresses their own namespace, never A\'s', async () => {
    const { storage, objects } = bucket([A_FILE]);
    const res = await del('_userpub/p/1.jpg', TOK_B, makeEnv({ STORAGE: storage }));
    expect(res.status).toBe(404);
    expect(storage.head).toHaveBeenCalledWith('myapp/_public/u/gh:2/p/1.jpg');
    expect(storage.delete).not.toHaveBeenCalled();
    expect(objects.has(A_FILE)).toBe(true);
  });

  it('lets a team admin take down any user\'s public upload by its returned key; a non-team user gets 403', async () => {
    const admin = bucket([A_FILE]);
    const asAdmin = await del('_public/u/gh:1/p/1.jpg', TOK_B, makeEnv({ STORAGE: admin.storage },
      mockD1(mockStmt({ first: { creator_id: 'gh:99' } }), mockStmt({ first: { role: 'admin' } }))));
    expect(asAdmin.status).toBe(204);
    expect(admin.objects.has(A_FILE)).toBe(false);

    const outsider = bucket([A_FILE]);
    const asOutsider = await del('_public/u/gh:1/p/1.jpg', OUTSIDER, makeEnv({ STORAGE: outsider.storage },
      mockD1(mockStmt({ first: { creator_id: 'gh:99' } }), mockStmt({ first: null }))));
    expect(asOutsider.status).toBe(403);
    expect(outsider.objects.has(A_FILE)).toBe(true);
  });

  it('does not let the uploader use the team takedown path, even for their own file', async () => {
    const { storage, objects } = bucket([A_FILE]);
    const res = await del('_public/u/gh:1/p/1.jpg', TOK, makeEnv({ STORAGE: storage },
      mockD1(mockStmt({ first: { creator_id: 'gh:99' } }), mockStmt({ first: null }))));
    expect(res.status).toBe(403);
    expect(objects.has(A_FILE)).toBe(true);
  });

  it('keeps owner-curated _public assets owner-only: a team admin gets 403, the owner deletes', async () => {
    const ASSET = 'myapp/_public/banner.png';
    const admin = bucket([ASSET]);
    const asAdmin = await del('_public/banner.png', TOK_B, makeEnv({ STORAGE: admin.storage },
      mockD1(mockStmt({ first: { creator_id: 'gh:1' } }), mockStmt({ first: { role: 'admin' } }))));
    expect(asAdmin.status).toBe(403);
    expect(admin.objects.has(ASSET)).toBe(true);

    const owner = bucket([ASSET]);
    const asOwner = await del('_public/banner.png', TOK, makeEnv({ STORAGE: owner.storage },
      mockD1(mockStmt({ first: { creator_id: 'gh:1' } }))));
    expect(asOwner.status).toBe(204);
    expect(owner.objects.has(ASSET)).toBe(false);
  });

  it('keeps private deletion scoped to the caller\'s own prefix', async () => {
    const A_PRIVATE = 'myapp/gh:1/notes/a.txt';
    const mine = bucket([A_PRIVATE]);
    expect((await del('notes/a.txt', TOK, makeEnv({ STORAGE: mine.storage }))).status).toBe(204);
    expect(mine.objects.has(A_PRIVATE)).toBe(false);

    const theirs = bucket([A_PRIVATE]);
    expect((await del('notes/a.txt', TOK_B, makeEnv({ STORAGE: theirs.storage }))).status).toBe(404);
    expect(theirs.objects.has(A_PRIVATE)).toBe(true);
  });

  it('answers 404 for a key that does not exist, in every namespace', async () => {
    const { storage } = bucket([]);
    const owner = () => makeEnv({ STORAGE: storage }, mockD1(mockStmt({ first: { creator_id: 'gh:1' } })));
    expect((await del('_userpub/nope.jpg', TOK, owner())).status).toBe(404);
    expect((await del('_public/u/gh:2/nope.jpg', TOK, owner())).status).toBe(404);
    expect((await del('_public/nope.jpg', TOK, owner())).status).toBe(404);
    expect((await del('nope.txt', TOK, owner())).status).toBe(404);
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('requires a session', async () => {
    const { storage } = bucket([A_FILE]);
    const res = await app.request('/v1/apps/myapp/storage/_userpub/p/1.jpg', { method: 'DELETE' }, makeEnv({ STORAGE: storage }));
    expect(res.status).toBe(401);
    expect(storage.delete).not.toHaveBeenCalled();
  });
});
