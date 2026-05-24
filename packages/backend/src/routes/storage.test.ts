import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { app } from '../index.js';

const originalFetch = globalThis.fetch;

function mockStmt(opts: { first?: unknown; all?: unknown; run?: unknown } = {}) {
  return {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(opts.first ?? null),
    all: vi.fn().mockResolvedValue(opts.all ?? { results: [] }),
    run: vi.fn().mockResolvedValue(opts.run ?? { meta: { changes: 0 } }),
  };
}

function mockD1(...stmts: ReturnType<typeof mockStmt>[]) {
  const prepare = vi.fn();
  for (const stmt of stmts) prepare.mockReturnValueOnce(stmt);
  prepare.mockReturnValue(mockStmt());
  return { prepare };
}

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
  return {
    DB: (db ?? mockD1()) as unknown as D1Database,
    STORAGE: makeStorage(),
    STRIPE_SECRET_KEY: 'sk_test',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    SESSION_SIGNING_KEY: 'sign_key',
    FAS_API_BASE: 'https://api.freeappstore.online',
    CF_API_TOKEN: 'cf_tok',
    CF_ACCOUNT_ID: 'cf_acct',
    VAPID_PUBLIC_KEY: 'test-vapid-public',
    VAPID_PRIVATE_KEY: 'test-vapid-private',
    ...overrides,
  };
}

beforeEach(() => {
  globalThis.fetch = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({ id: 'gh:1', login: 'tester', avatarUrl: null, roles: ['user'], appRoles: {} }),
      { status: 200 },
    ),
  );
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('PUT /v1/apps/:appId/storage/* — upload', () => {
  it('returns 401 without auth', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
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
        headers: { Authorization: 'Bearer tok', 'Content-Type': 'text/html' },
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
        headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/javascript' },
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
        headers: { Authorization: 'Bearer tok', 'Content-Type': 'image/svg+xml' },
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
        headers: { Authorization: 'Bearer tok', 'Content-Type': 'text/javascript' },
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
        headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/xhtml+xml' },
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
        headers: { Authorization: 'Bearer tok', 'Content-Type': 'image/png' },
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
        headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/pdf' },
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
        headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
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
        headers: { Authorization: 'Bearer tok', 'Content-Type': 'text/plain; charset=utf-8' },
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
        headers: { Authorization: 'Bearer tok', 'Content-Type': 'image/png' },
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
        headers: { Authorization: 'Bearer tok', 'Content-Type': 'image/png' },
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
        headers: { Authorization: 'Bearer tok', 'Content-Type': 'text/plain' },
        body: new Uint8Array(Buffer.from('draft')),
      },
      makeEnv({ STORAGE: storage }),
    );
    const putCall = vi.mocked(storage.put).mock.calls[0];
    const key = putCall[0] as string;
    expect(key).toBe('myapp/gh:1/notes/draft.txt');
  });

  it('uses _public prefix for public files without user scope', async () => {
    const storage = makeStorage();
    await app.request(
      '/v1/apps/myapp/storage/_public/logo.png',
      {
        method: 'PUT',
        headers: { Authorization: 'Bearer tok', 'Content-Type': 'image/png' },
        body: new Uint8Array([1, 2, 3]),
      },
      makeEnv({ STORAGE: storage }),
    );
    const putCall = vi.mocked(storage.put).mock.calls[0];
    const key = putCall[0] as string;
    expect(key).toBe('myapp/_public/logo.png');
    expect(key).not.toContain('gh:1');
  });
});
