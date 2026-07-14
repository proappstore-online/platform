import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('web-push', () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn().mockResolvedValue({}),
  },
}));

import { app } from '../index.js';
import webpush from 'web-push';
import { testToken, TEST_SK, mockStmt, mockD1, makeEnv as sharedMakeEnv } from '../test-helpers.js';

const TOK = await testToken('gh:1');

function makeEnv(db?: ReturnType<typeof mockD1>) {
  return sharedMakeEnv({}, db);
}

beforeEach(() => {
  vi.mocked(webpush.sendNotification).mockClear();
  vi.mocked(webpush.setVapidDetails).mockClear();
});

describe('GET /v1/notifications/vapid-key', () => {
  it('returns the VAPID public key without auth', async () => {
    const res = await app.request('/v1/notifications/vapid-key', {}, makeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ publicKey: 'test-vapid-public' });
  });
});

describe('POST /v1/notifications/subscribe', () => {
  it('inserts subscription and returns ok', async () => {
    const stmt = mockStmt();
    const db = mockD1(stmt);
    const res = await app.request('/v1/notifications/subscribe', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appId: 'myapp',
        endpoint: 'https://push.example.com/sub1',
        p256dh: 'p256dh-key',
        auth: 'auth-secret',
      }),
    }, makeEnv(db));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(db.prepare).toHaveBeenCalled();
    const sql = db.prepare.mock.calls[0][0];
    expect(sql).toContain('INSERT INTO push_subscriptions');
    expect(sql).toContain('ON CONFLICT(endpoint)');
    expect(stmt.bind).toHaveBeenCalledWith(
      expect.any(String),  // id (uuid)
      'gh:1',              // user_id
      'myapp',             // app_id
      'https://push.example.com/sub1',
      'p256dh-key',
      'auth-secret',
      expect.any(Number),  // created_at
    );
  });

  it('returns 400 when fields are missing', async () => {
    const res = await app.request('/v1/notifications/subscribe', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: 'myapp', endpoint: '' }),
    }, makeEnv());

    expect(res.status).toBe(400);
  });

  it('returns 401 without auth', async () => {
    const res = await app.request('/v1/notifications/subscribe', {
      method: 'POST',
      headers: { Authorization: 'Bearer bad', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appId: 'myapp',
        endpoint: 'https://push.example.com/sub1',
        p256dh: 'key',
        auth: 'secret',
      }),
    }, makeEnv());

    expect(res.status).toBe(401);
  });
});

describe('POST /v1/notifications/unsubscribe', () => {
  it('deletes subscription by endpoint and user_id', async () => {
    const stmt = mockStmt();
    const db = mockD1(stmt);
    const res = await app.request('/v1/notifications/unsubscribe', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: 'https://push.example.com/sub1' }),
    }, makeEnv(db));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const sql = db.prepare.mock.calls[0][0];
    expect(sql).toContain('DELETE FROM push_subscriptions');
    expect(stmt.bind).toHaveBeenCalledWith('https://push.example.com/sub1', 'gh:1');
  });

  it('returns 400 when endpoint is missing', async () => {
    const res = await app.request('/v1/notifications/unsubscribe', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }, makeEnv());

    expect(res.status).toBe(400);
  });

  it('returns 401 without auth', async () => {
    const res = await app.request('/v1/notifications/unsubscribe', {
      method: 'POST',
      headers: { Authorization: 'Bearer bad', 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: 'https://push.example.com/sub1' }),
    }, makeEnv());

    expect(res.status).toBe(401);
  });
});

describe('POST /v1/notifications/send', () => {
  it('sends to a specific user and returns sent/failed counts', async () => {
    const appsStmt = mockStmt({ first: { creator_id: 'gh:1' } });
    const subsStmt = mockStmt({
      all: {
        results: [
          { id: '1', user_id: 'u2', app_id: 'myapp', endpoint: 'https://push.example.com/sub1', p256dh: 'k1', auth_secret: 's1', created_at: 1 },
        ],
      },
    });
    const db = mockD1(appsStmt, subsStmt);

    const res = await app.request('/v1/notifications/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appId: 'myapp',
        userId: 'u2',
        title: 'Hello',
        body: 'World',
      }),
    }, makeEnv(db));

    expect(res.status).toBe(200);
    const data = await res.json() as { sent: number; failed: number };
    expect(data).toEqual({ sent: 1, failed: 0 });
    expect(webpush.setVapidDetails).toHaveBeenCalledWith(
      'mailto:push@proappstore.online',
      'test-vapid-public',
      'test-vapid-private',
    );
    expect(webpush.sendNotification).toHaveBeenCalledWith(
      { endpoint: 'https://push.example.com/sub1', keys: { p256dh: 'k1', auth: 's1' } },
      expect.any(String),
    );

    // Verify the payload JSON
    const payload = JSON.parse(vi.mocked(webpush.sendNotification).mock.calls[0][1] as string);
    expect(payload.title).toBe('Hello');
    expect(payload.body).toBe('World');
  });

  it('broadcasts to all subscribers when userId is omitted', async () => {
    const appsStmt = mockStmt({ first: { creator_id: 'gh:1' } });
    const subsStmt = mockStmt({
      all: {
        results: [
          { id: '1', endpoint: 'https://push.example.com/a', p256dh: 'k1', auth_secret: 's1' },
          { id: '2', endpoint: 'https://push.example.com/b', p256dh: 'k2', auth_secret: 's2' },
        ],
      },
    });
    const db = mockD1(appsStmt, subsStmt);

    const res = await app.request('/v1/notifications/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: 'myapp', title: 'News', body: 'Update' }),
    }, makeEnv(db));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: 2, failed: 0 });
    expect(webpush.sendNotification).toHaveBeenCalledTimes(2);

    // Verify the subscription query is for all app subscribers (no user_id filter)
    const subsSql = db.prepare.mock.calls[1][0];
    expect(subsSql).toContain('WHERE app_id = ?1');
    expect(subsSql).not.toContain('user_id');
  });

  it('cleans up dead endpoints on 410', async () => {
    const appsStmt = mockStmt({ first: { creator_id: 'gh:1' } });
    const subsStmt = mockStmt({
      all: {
        results: [
          { id: '1', endpoint: 'https://push.example.com/alive', p256dh: 'k1', auth_secret: 's1' },
          { id: '2', endpoint: 'https://push.example.com/dead', p256dh: 'k2', auth_secret: 's2' },
        ],
      },
    });
    const cleanupStmt = mockStmt();
    const db = mockD1(appsStmt, subsStmt, cleanupStmt);

    vi.mocked(webpush.sendNotification)
      .mockResolvedValueOnce({} as any)
      .mockRejectedValueOnce({ statusCode: 410 });

    const res = await app.request('/v1/notifications/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: 'myapp', title: 'T', body: 'B' }),
    }, makeEnv(db));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: 1, failed: 1 });

    // Verify dead endpoint cleanup query
    const cleanupSql = db.prepare.mock.calls[2][0];
    expect(cleanupSql).toContain('DELETE FROM push_subscriptions WHERE endpoint IN');
    expect(cleanupStmt.bind).toHaveBeenCalledWith('https://push.example.com/dead');
  });

  it('cleans up dead endpoints on 404', async () => {
    const appsStmt = mockStmt({ first: { creator_id: 'gh:1' } });
    const subsStmt = mockStmt({
      all: {
        results: [
          { id: '1', endpoint: 'https://push.example.com/gone', p256dh: 'k1', auth_secret: 's1' },
        ],
      },
    });
    const cleanupStmt = mockStmt();
    const db = mockD1(appsStmt, subsStmt, cleanupStmt);

    vi.mocked(webpush.sendNotification).mockRejectedValueOnce({ statusCode: 404 });

    const res = await app.request('/v1/notifications/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: 'myapp', title: 'T', body: 'B' }),
    }, makeEnv(db));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: 0, failed: 1 });
    expect(db.prepare).toHaveBeenCalledTimes(3); // apps + subs + cleanup
  });

  it('does not run cleanup when no dead endpoints', async () => {
    const appsStmt = mockStmt({ first: { creator_id: 'gh:1' } });
    const subsStmt = mockStmt({
      all: {
        results: [
          { id: '1', endpoint: 'https://push.example.com/ok', p256dh: 'k1', auth_secret: 's1' },
        ],
      },
    });
    const db = mockD1(appsStmt, subsStmt);

    const res = await app.request('/v1/notifications/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: 'myapp', title: 'T', body: 'B' }),
    }, makeEnv(db));

    expect(res.status).toBe(200);
    expect(db.prepare).toHaveBeenCalledTimes(3); // apps + subs + webhook dispatch query (no cleanup)
  });

  it('returns 403 when user is not app creator', async () => {
    const appsStmt = mockStmt({ first: { creator_id: 'gh:999' } });
    const db = mockD1(appsStmt);

    const res = await app.request('/v1/notifications/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: 'myapp', title: 'T', body: 'B' }),
    }, makeEnv(db));

    expect(res.status).toBe(403);
  });

  it('returns 403 when app does not exist', async () => {
    const appsStmt = mockStmt({ first: null });
    const db = mockD1(appsStmt);

    const res = await app.request('/v1/notifications/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: 'noapp', title: 'T', body: 'B' }),
    }, makeEnv(db));

    expect(res.status).toBe(403);
  });

  it('returns 400 when required fields are missing', async () => {
    const res = await app.request('/v1/notifications/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: 'myapp' }),
    }, makeEnv());

    expect(res.status).toBe(400);
  });

  it('returns 401 without auth', async () => {
    const res = await app.request('/v1/notifications/send', {
      method: 'POST',
      headers: { Authorization: 'Bearer bad', 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: 'myapp', title: 'T', body: 'B' }),
    }, makeEnv());

    expect(res.status).toBe(401);
  });

  it('returns {sent:0, failed:0} when no subscribers', async () => {
    const appsStmt = mockStmt({ first: { creator_id: 'gh:1' } });
    const subsStmt = mockStmt({ all: { results: [] } });
    const db = mockD1(appsStmt, subsStmt);

    const res = await app.request('/v1/notifications/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: 'myapp', title: 'T', body: 'B' }),
    }, makeEnv(db));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: 0, failed: 0 });
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  it('includes optional fields in push payload', async () => {
    const appsStmt = mockStmt({ first: { creator_id: 'gh:1' } });
    const subsStmt = mockStmt({
      all: {
        results: [
          { id: '1', endpoint: 'https://push.example.com/x', p256dh: 'k', auth_secret: 's' },
        ],
      },
    });
    const db = mockD1(appsStmt, subsStmt);

    await app.request('/v1/notifications/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appId: 'myapp',
        title: 'Event',
        body: 'Tomorrow',
        url: '/events/1',
        icon: '/icon.png',
        tag: 'event-1',
      }),
    }, makeEnv(db));

    const payload = JSON.parse(vi.mocked(webpush.sendNotification).mock.calls[0][1] as string);
    expect(payload.url).toBe('/events/1');
    expect(payload.icon).toBe('/icon.png');
    expect(payload.tag).toBe('event-1');
  });
});

describe('POST /v1/notifications/send-internal', () => {
  beforeEach(() => vi.mocked(webpush.sendNotification).mockClear());
  const SUB = { endpoint: 'https://push/1', p256dh: 'p', auth_secret: 'a' };

  it('403s without the internal token', async () => {
    const res = await app.request('/v1/notifications/send-internal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'gh:1', appId: 'console', title: 't', body: 'b' }),
    }, { ...makeEnv(), INTERNAL_TOKEN: 'secret' });
    expect(res.status).toBe(403);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  it('sends to the target user’s subscriptions with a valid internal token', async () => {
    const db = mockD1(mockStmt({ all: { results: [SUB] } })); // the SELECT subscriptions
    const res = await app.request('/v1/notifications/send-internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': 'secret' },
      body: JSON.stringify({ userId: 'gh:1', appId: 'console', title: 'Photo flow needs your input', body: 'Tap to respond', url: 'https://console.proappstore.online/#/apps/x/build', tag: 't1' }),
    }, { ...makeEnv(db), INTERNAL_TOKEN: 'secret' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: 1, failed: 0 });
    const payload = JSON.parse(vi.mocked(webpush.sendNotification).mock.calls[0][1] as string);
    expect(payload.title).toContain('needs your input');
    expect(payload.tag).toBe('t1');
  });

  it('400s on missing fields', async () => {
    const res = await app.request('/v1/notifications/send-internal', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Internal-Token': 'secret' },
      body: JSON.stringify({ userId: 'gh:1', appId: 'console' }),
    }, { ...makeEnv(), INTERNAL_TOKEN: 'secret' });
    expect(res.status).toBe(400);
  });
});
