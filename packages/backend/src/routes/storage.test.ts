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

// #208: review uploads. Readers are the uploader and live holders of the app's
// declared review roles — never the team, never 'member', never cached.
describe('review uploads — _review namespace, reviewer roles, audit (#208)', () => {
  const CERT = 'myapp/_review/u/gh:1/cert.pdf';
  type State = {
    objects: Map<string, Uint8Array>; config: string[] | null; roles: Map<string, string[]>;
    team: Map<string, string>; creator: string; audit: unknown[][]; auditFails: boolean;
  };
  let state: State;
  beforeEach(() => {
    state = {
      objects: new Map(), config: ['moderator'], roles: new Map([['gh:2', ['moderator']]]),
      team: new Map([['gh:9', 'admin']]), creator: 'gh:8', audit: [], auditFails: false,
    };
  });

  function storage(): R2Bucket {
    return makeStorage({
      put: vi.fn(async (key: string, body: ArrayBuffer) => { state.objects.set(key, new Uint8Array(body)); }) as unknown as R2Bucket['put'],
      head: vi.fn(async (key: string) => (state.objects.has(key) ? { key } : null)) as unknown as R2Bucket['head'],
      get: vi.fn(async (key: string) => {
        const bytes = state.objects.get(key);
        return bytes ? { body: bytes, httpEtag: '"e"', writeHttpMetadata: (h: Headers) => h.set('content-type', 'application/pdf') } : null;
      }) as unknown as R2Bucket['get'],
      delete: vi.fn(async (key: string) => { state.objects.delete(key); }) as unknown as R2Bucket['delete'],
    });
  }
  function db() {
    const answer = (sql: string, args: unknown[]): { first?: unknown; all?: unknown; run?: unknown } => {
      if (sql.includes('SELECT creator_id FROM apps')) return { first: { creator_id: state.creator } };
      if (sql.includes('FROM team_members')) return { first: state.team.has(args[1] as string) ? { role: state.team.get(args[1] as string) } : null };
      if (sql.includes('INSERT INTO app_storage_config')) { state.config = JSON.parse(args[1] as string); return { run: {} }; }
      if (sql.includes('FROM app_storage_config')) return { first: state.config ? { review_roles: JSON.stringify(state.config) } : null };
      if (sql.includes('FROM app_roles')) {
        const [, id, , ...wanted] = args as string[];
        return { first: (state.roles.get(id) ?? []).some((r) => wanted.includes(r)) ? { 1: 1 } : null };
      }
      if (sql.includes('INSERT INTO storage_review_access')) {
        if (state.auditFails) throw new Error('D1 unavailable');
        state.audit.push(args); return { run: {} };
      }
      if (sql.includes('FROM storage_review_access')) {
        return { all: { results: state.audit.map(([, owner_id, path, actor_id, action, created_at]) => ({ owner_id, path, actor_id, action, created_at })) } };
      }
      return {};
    };
    return {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          first: async () => answer(sql, args).first ?? null,
          all: async () => answer(sql, args).all ?? { results: [] },
          run: async () => answer(sql, args).run ?? { meta: {} },
        }),
      }),
    } as unknown as ReturnType<typeof mockD1>;
  }
  const env = () => makeEnv({ STORAGE: storage() }, db());
  const req = (method: string, path: string, token?: string, init: RequestInit = {}) =>
    app.request(path, { method, ...init, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers as Record<string, string> ?? {}) } }, env());
  const upload = (type = 'application/pdf', path = '_review/cert.pdf') =>
    req('PUT', `/v1/apps/myapp/storage/${path}`, TOK, { body: new Uint8Array([37, 80, 68, 70]), headers: { 'Content-Type': type } });
  const read = (token?: string, path = '_review/u/gh:1/cert.pdf') => req('GET', `/v1/apps/myapp/storage/${path}`, token);

  it('stores an upload privately under the uploader and returns its review path; documents only', async () => {
    const res = await upload();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ key: '_review/u/gh:1/cert.pdf', url: '/v1/apps/myapp/storage/_review/u/gh:1/cert.pdf' });
    expect(state.objects.has(CERT)).toBe(true);
    for (const type of ['text/html', 'application/xml', 'image/svg+xml', 'application/octet-stream']) {
      expect((await upload(type, '_review/x')).status, type).toBe(400);
    }
  });

  it('a user without the role gets 403; the declared reviewer gets 200, private no-store, and is audited', async () => {
    await upload();
    const denied = await read(OUTSIDER);
    expect(denied.status).toBe(403);
    expect(state.audit).toEqual([]);

    const ok = await read(TOK_B);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('private, no-store');
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
    expect(ok.headers.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(new Uint8Array([37, 80, 68, 70]));
    expect(state.audit).toEqual([['myapp', 'gh:1', 'cert.pdf', 'gh:2', 'read', expect.any(Number)]]);
  });

  it('revocation is immediate: revoking the role, or removing it from the config, denies the next read', async () => {
    await upload();
    expect((await read(TOK_B)).status).toBe(200);
    state.roles.set('gh:2', []);
    expect((await read(TOK_B)).status).toBe(403);
    state.roles.set('gh:2', ['moderator']);
    state.config = ['verifier'];
    expect((await read(TOK_B)).status).toBe(403);
    state.config = null; // no config at all: nobody but the uploader
    expect((await read(TOK_B)).status).toBe(403);
  });

  it('the uploader reads their own upload without an audit row', async () => {
    await upload();
    const res = await read(TOK);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(state.audit).toEqual([]);
  });

  it('the app team and the app creator are not reviewers', async () => {
    await upload();
    state.team.set('gh:3', 'admin');
    state.creator = 'gh:3';
    expect((await read(OUTSIDER)).status).toBe(403);
  });

  it("a stale config naming 'member' grants nothing", async () => {
    await upload();
    state.config = ['member'];
    state.roles.set('gh:3', ['member']);
    expect((await read(OUTSIDER)).status).toBe(403);
  });

  it('is never public: unauthenticated /public/_review is 404 and unauthenticated /storage/_review is 401', async () => {
    await upload();
    expect((await req('GET', '/v1/apps/myapp/public/_review/u/gh:1/cert.pdf')).status).toBe(404);
    expect((await req('GET', '/v1/apps/myapp/public/u/gh:1/cert.pdf')).status).toBe(404);
    expect((await read()).status).toBe(401);
  });

  it('an encoded user id (as the SDK sends it) addresses the same file for the uploader and the reviewer', async () => {
    await upload();
    expect((await read(TOK, '_review/u/gh%3A1/cert.pdf')).status).toBe(200);
    expect((await read(TOK_B, '_review/u/gh%3A1/cert.pdf')).status).toBe(200);
    expect(state.audit).toEqual([['myapp', 'gh:1', 'cert.pdf', 'gh:2', 'read', expect.any(Number)]]);
    expect((await read(TOK, '_review/u/%E0%A4%A/cert.pdf')).status).toBe(400);
  });

  it('refuses a malformed review path and answers 404 for a missing file only after authorization', async () => {
    expect((await read(TOK, '_review/cert.pdf')).status).toBe(400);
    expect((await read(OUTSIDER, '_review/u/gh:1/nope.pdf')).status).toBe(403); // no existence oracle for strangers
    expect((await read(TOK_B, '_review/u/gh:1/nope.pdf')).status).toBe(404);
  });

  it('fails closed when the audit cannot be written: nothing is served or deleted', async () => {
    await upload();
    state.auditFails = true;
    expect((await read(TOK_B)).status).toBe(500);
    expect((await req('DELETE', '/v1/apps/myapp/storage/_review/u/gh:1/cert.pdf', TOK_B)).status).toBe(500);
    expect(state.objects.has(CERT)).toBe(true);
  }, 10_000);

  it('the uploader or a reviewer may delete (the reviewer audited); anyone else gets 403', async () => {
    await upload();
    expect((await req('DELETE', '/v1/apps/myapp/storage/_review/u/gh:1/cert.pdf', OUTSIDER)).status).toBe(403);
    expect(state.objects.has(CERT)).toBe(true);
    expect((await req('DELETE', '/v1/apps/myapp/storage/_review/u/gh:1/cert.pdf', TOK_B)).status).toBe(204);
    expect(state.objects.has(CERT)).toBe(false);
    expect(state.audit).toEqual([['myapp', 'gh:1', 'cert.pdf', 'gh:2', 'delete', expect.any(Number)]]);
    await upload();
    state.audit = [];
    expect((await req('DELETE', '/v1/apps/myapp/storage/_review/u/gh:1/cert.pdf', TOK)).status).toBe(204);
    expect(state.audit).toEqual([]);
  });

  it('storage-config: team admin declares roles; member and malformed roles are refused; others get 403', async () => {
    const put = (token: string, review_roles: unknown) =>
      req('PUT', '/v1/apps/myapp/storage-config', token, { body: JSON.stringify({ review_roles }), headers: { 'Content-Type': 'application/json' } });
    const ADMIN = await testToken('gh:9');
    const ok = await put(ADMIN, ['verifier', 'verifier', 'moderator']);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ review_roles: ['verifier', 'moderator'] });
    expect(state.config).toEqual(['verifier', 'moderator']);
    expect((await put(ADMIN, ['member'])).status).toBe(400);
    expect((await put(ADMIN, ['Bad Role'])).status).toBe(400);
    expect((await put(ADMIN, 'moderator')).status).toBe(400);
    expect((await put(TOK_B, ['moderator'])).status).toBe(403); // a reviewer is not the team
    const got = await req('GET', '/v1/apps/myapp/storage-config', ADMIN);
    expect(await got.json()).toEqual({ review_roles: ['verifier', 'moderator'] });
  });

  it('storage-review-access: the team admin reads the audit trail; a reviewer cannot', async () => {
    await upload();
    await read(TOK_B);
    const trail = await req('GET', '/v1/apps/myapp/storage-review-access', await testToken('gh:9'));
    expect(trail.status).toBe(200);
    expect(await trail.json()).toEqual({ access: [{ owner_id: 'gh:1', path: 'cert.pdf', actor_id: 'gh:2', action: 'read', created_at: expect.any(Number) }] });
    expect((await req('GET', '/v1/apps/myapp/storage-review-access', TOK_B)).status).toBe(403);
  });

  it('leaves the existing private namespace unchanged', async () => {
    const put = await req('PUT', '/v1/apps/myapp/storage/notes/a.txt', TOK, { body: 'hi', headers: { 'Content-Type': 'text/plain' } });
    expect(put.status).toBe(200);
    expect(state.objects.has('myapp/gh:1/notes/a.txt')).toBe(true);
    expect((await req('GET', '/v1/apps/myapp/storage/notes/a.txt', TOK)).headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });
});

// #216: objects already stored with an active-document type (e.g. an SVG
// listing icon uploaded before the rule) are served sandboxed, so opening one
// directly cannot run script on the API origin. Raster files are unchanged.
describe('GET /v1/apps/:appId/public/* — active documents are sandboxed (#216)', () => {
  const serve = (key: string, contentType: string) => {
    const storage = makeStorage({
      get: vi.fn(async (k: string) => (k === `myapp/_public/${key}` ? {
        body: new Uint8Array([1]), httpEtag: '"e"', writeHttpMetadata: (h: Headers) => h.set('content-type', contentType),
      } : null)) as unknown as R2Bucket['get'],
    });
    return app.request(`/v1/apps/myapp/public/${key}`, {}, makeEnv({ STORAGE: storage }));
  };
  const SANDBOX = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

  it('serves stored SVG, XML, XHTML and HTML with a sandboxing CSP', async () => {
    for (const [key, type] of [
      ['listing/icon-1.svg', 'image/svg+xml'],
      ['u/gh:1/feed.xml', 'application/xml'],
      ['u/gh:1/page.xml', 'text/xml; charset=utf-8'],
      ['legacy/page.xhtml', 'application/xhtml+xml'],
      ['legacy/page.html', 'text/html'],
    ] as const) {
      const res = await serve(key, type);
      expect(res.status, key).toBe(200);
      expect(res.headers.get('content-security-policy'), key).toBe(SANDBOX);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    }
  });

  it('sandboxes a .svg key even when its stored type is generic', async () => {
    expect((await serve('listing/icon-2.svg', 'application/octet-stream')).headers.get('content-security-policy')).toBe(SANDBOX);
  });

  it('leaves raster images and PDFs as they were (no sandbox, still cached)', async () => {
    for (const [key, type] of [['listing/icon-3.png', 'image/png'], ['u/gh:1/doc.pdf', 'application/pdf']] as const) {
      const res = await serve(key, type);
      expect(res.headers.get('content-security-policy'), key).toBeNull();
      expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    }
  });
});
