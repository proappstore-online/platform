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

// #209: notify-user's email channel. A SQL-routed D1 fake with real state, so a
// test reads like the flow: membership, opt-out, verified address, limits.
describe('POST /v1/notifications/notify-user — push unchanged, email channel (#209)', () => {
  const ADDRESS = 'bob@example.com';
  type State = {
    members: Set<string>; optouts: Set<string>; emails: Map<string, string | null>; subs: Set<string>;
    log: { sender: string; target: string }[]; usage: { id: number; target: string | null }[]; domains: Set<string>;
  };
  let state: State;
  let resend: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    state = {
      members: new Set(['gh:1', 'u2']), optouts: new Set(), emails: new Map([['u2', ADDRESS], ['cred:kid', null]]),
      subs: new Set(['gh:1']), log: [], usage: [], domains: new Set(['shop.example.com']),
    };
    resend = vi.fn(async () => Response.json({ id: 'email-1' }));
    vi.stubGlobal('fetch', resend);
  });
  afterEach(() => vi.unstubAllGlobals());

  function db() {
    const answer = (sql: string, args: unknown[]) => {
      if (sql.includes('FROM push_subscriptions WHERE app_id = ?1 AND user_id = ?2 LIMIT 1')) return { first: state.subs.has(args[1] as string) ? { 1: 1 } : null };
      if (sql.includes('SELECT * FROM push_subscriptions')) {
        const results = state.subs.has(args[1] as string) ? [{ id: '1', user_id: args[1], app_id: 'myapp', endpoint: `https://push.example/${args[1]}`, p256dh: 'k', auth_secret: 's', created_at: 1 }] : [];
        return { all: { results } };
      }
      if (sql.includes('FROM app_roles')) return { first: state.members.has(args[1] as string) ? { 1: 1 } : null };
      if (sql.includes('FROM notification_email_optout')) return { first: state.optouts.has(`${args[0]}:${args[1]}`) ? { 1: 1 } : null };
      if (sql.includes('INSERT OR IGNORE INTO notification_email_optout')) { state.optouts.add(`${args[0]}:${args[1]}`); return { run: {} }; }
      if (sql.includes('SELECT email FROM users')) return { first: state.emails.has(args[0] as string) ? { email: state.emails.get(args[0] as string) } : null };
      if (sql.includes('FROM app_custom_domains')) return { first: state.domains.has(args[1] as string) ? { 1: 1 } : null };
      if (sql.includes('FROM notification_log') && sql.includes('sender_id = ?1')) return { first: { n: state.log.filter((l) => l.sender === args[0]).length } };
      if (sql.includes('FROM notification_log')) return { first: { n: state.log.filter((l) => l.target === args[0]).length } };
      if (sql.includes('INSERT INTO notification_log')) { state.log.push({ sender: args[0] as string, target: args[2] as string }); return { run: {} }; }
      if (sql.includes('DELETE FROM email_usage')) { state.usage = state.usage.filter((u) => u.id !== args[0]); return { run: {} }; }
      if (sql.includes('FROM email_usage') && sql.includes('target_user_id')) return { first: { n: state.usage.filter((u) => u.target === args[1]).length } };
      if (sql.includes('FROM email_usage')) return { first: { n: state.usage.length } };
      if (sql.includes('INSERT INTO email_usage')) { const id = state.usage.length + 1; state.usage.push({ id, target: args[3] as string }); return { run: { meta: { last_row_id: id } } }; }
      return {};
    };
    return {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => {
          const a = () => answer(sql, args);
          return { first: async () => a().first ?? null, all: async () => a().all ?? { results: [] }, run: async () => a().run ?? { meta: {} } };
        },
      }),
    } as unknown as ReturnType<typeof mockD1>;
  }
  // #213: email content is moderated on Workers AI; a clean verdict by default.
  let ai: { run: ReturnType<typeof vi.fn> };
  beforeEach(() => { ai = { run: vi.fn(async () => ({ response: 'safe' })) }; });
  const env = (overrides: Record<string, unknown> = {}) => sharedMakeEnv({ RESEND_API_KEY: 're_test', AI: ai, ...overrides }, db());
  const notify = (payload: Record<string, unknown>, e = env(), token = TOK) => app.request('/v1/notifications/notify-user', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId: 'myapp', targetUserId: 'u2', title: 'New inquiry', body: 'Bob asked about <pumps>', ...payload }),
  }, e);
  const sentMail = (i = 0) => JSON.parse(resend.mock.calls[i]![1].body as string) as { to: string; subject: string; html: string; text: string; headers: Record<string, string> };

  it('push is unchanged when channel is omitted: subscription gate, {sent, failed}, no email', async () => {
    state.subs.add('u2');
    const res = await notify({});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: 1, failed: 0 });
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
    expect(resend).not.toHaveBeenCalled();
    state.subs.delete('gh:1');
    expect((await notify({})).status).toBe(403);
  });

  it('emails a member at the platform-stored address, which the response never contains', async () => {
    state.subs.clear(); // email needs membership, not a push subscription
    const res = await notify({ channel: 'email', url: 'https://myapp.proappstore.online/inquiries/7' });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ sent: 0, failed: 0, email: 'sent' });
    expect(text).not.toContain(ADDRESS);
    const mail = sentMail();
    expect(mail.to).toBe(ADDRESS);
    expect(mail.subject).toBe('myapp: New inquiry');
    expect(mail.html).toContain('Bob asked about &lt;pumps&gt;');
    expect(mail.html).toContain('href="https://myapp.proappstore.online/inquiries/7"');
    expect(mail.headers['List-Unsubscribe']).toMatch(/^<https:\/\/api\.proappstore\.online\/v1\/notifications\/email\/unsubscribe\?t=[\w-]+\.[\w-]+>$/);
    expect(mail.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(state.usage).toEqual([{ id: 1, target: 'u2' }]);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  it('channel both pushes and emails', async () => {
    state.subs.add('u2');
    const res = await notify({ channel: 'both' });
    expect(await res.json()).toEqual({ sent: 1, failed: 0, email: 'sent' });
    expect(resend).toHaveBeenCalledTimes(1);
  });

  it('after one-click unsubscribe the next call returns ok with skipped "unsubscribed" and sends nothing', async () => {
    await notify({ channel: 'email' });
    const unsubscribe = sentMail().headers['List-Unsubscribe']!.slice(1, -1);
    const path = new URL(unsubscribe).pathname + new URL(unsubscribe).search;

    const page = await app.request(path, {}, env());
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<form method="post"');
    expect(state.optouts.size).toBe(0); // a prefetched GET changes nothing

    const post = await app.request(path, { method: 'POST', body: 'List-Unsubscribe=One-Click', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, env());
    expect(post.status).toBe(200);
    expect(state.optouts.has('myapp:u2')).toBe(true);

    resend.mockClear();
    const res = await notify({ channel: 'email' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: 0, failed: 0, email: 'skipped', skipped: 'unsubscribed' });
    expect(resend).not.toHaveBeenCalled();
  });

  it('refuses a forged or tampered unsubscribe token', async () => {
    await notify({ channel: 'email' });
    const token = new URL(sentMail().headers['List-Unsubscribe']!.slice(1, -1)).searchParams.get('t')!;
    const [, sig] = token.split('.');
    const otherUser = btoa(JSON.stringify({ a: 'myapp', u: 'victim' })).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    for (const bad of [`${otherUser}.${sig}`, 'garbage', '']) {
      const res = await app.request(`/v1/notifications/email/unsubscribe?t=${bad}`, { method: 'POST' }, env());
      expect(res.status, bad).toBe(400);
    }
    expect(state.optouts.size).toBe(0);
  });

  it('the 11th call in a minute to the same recipient returns 429', async () => {
    for (let i = 0; i < 10; i++) expect((await notify({ channel: 'email' })).status).toBe(200);
    expect((await notify({ channel: 'email' })).status).toBe(429);
  });

  it('enforces the daily caps before sending anything: 100/day per app, 10/day per recipient', async () => {
    state.usage = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, target: null }));
    state.subs.add('u2');
    const appCap = await notify({ channel: 'both' });
    expect(appCap.status).toBe(429);
    expect(webpush.sendNotification).not.toHaveBeenCalled(); // no push before a refused email
    state.usage = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, target: 'u2' }));
    expect((await notify({ channel: 'email' })).status).toBe(429);
    expect(resend).not.toHaveBeenCalled();
  });

  it("rejects a url not on the app's own origin with 400; an active custom domain is allowed", async () => {
    for (const url of ['https://evil.example/x', 'http://myapp.proappstore.online/', 'https://other.proappstore.online/', 'javascript:alert(1)']) {
      expect((await notify({ channel: 'email', url })).status, url).toBe(400);
    }
    expect((await notify({ channel: 'email', url: 'https://shop.example.com/p/1' })).status).toBe(200);
    expect(resend).toHaveBeenCalledTimes(1);
  });

  it('skips a recipient with no verified address, and one who is not a member', async () => {
    state.members.add('cred:kid');
    const noAddress = await notify({ channel: 'email', targetUserId: 'cred:kid' });
    expect(await noAddress.json()).toEqual({ sent: 0, failed: 0, email: 'skipped', skipped: 'no_address' });
    const stranger = await notify({ channel: 'email', targetUserId: 'u9' });
    expect(await stranger.json()).toEqual({ sent: 0, failed: 0, email: 'skipped', skipped: 'not_member' });
    expect(resend).not.toHaveBeenCalled();
  });

  it('403s a caller who is not a member, and 503s when email is not configured', async () => {
    state.members.delete('gh:1');
    expect((await notify({ channel: 'email' })).status).toBe(403);
    state.members.add('gh:1');
    expect((await notify({ channel: 'email' }, env({ RESEND_API_KEY: undefined }))).status).toBe(503);
    expect((await notify({ channel: 'fax' })).status).toBe(400);
  });

  it('a failed send answers 502 and returns the reserved daily slot', async () => {
    resend.mockResolvedValue(new Response('down', { status: 500 }));
    expect((await notify({ channel: 'email' })).status).toBe(502);
    expect(state.usage).toEqual([]);

  });

  // #213 (child of #27): Workers AI content moderation of the email channel.
  describe('Workers AI content moderation (#213)', () => {
    const unsafe = () => ai.run.mockResolvedValue({ response: 'unsafe\nS2,S10' });

    it('unsafe content → 422 with the categories; nothing sent, no quota spent, audit line without content', async () => {
      unsafe();
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      state.subs.add('u2');
      const res = await notify({ channel: 'both', title: 'Verify your account', body: 'click here: evil.example' });
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: 'message rejected by content moderation', categories: ['S2', 'S10'] });
      expect(resend).not.toHaveBeenCalled();
      expect(webpush.sendNotification).not.toHaveBeenCalled(); // `both`: refused before anything is sent
      expect(state.usage).toEqual([]);
      const audit = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes('notify_user_moderation'))!;
      expect(JSON.parse(audit)).toEqual({ event: 'notify_user_moderation', app_id: 'myapp', sender_id: 'gh:1', target_user_id: 'u2', verdict: 'unsafe', categories: ['S2', 'S10'] });
      expect(audit).not.toContain('evil.example');
      log.mockRestore();
    });

    it('moderates title and body together with Llama Guard on the existing binding', async () => {
      await notify({ channel: 'email', title: 'New inquiry', body: 'Bob asked about pumps' });
      expect(ai.run).toHaveBeenCalledTimes(1);
      expect(ai.run).toHaveBeenCalledWith('@cf/meta/llama-guard-3-8b', { messages: [{ role: 'user', content: 'New inquiry\n\nBob asked about pumps' }] });
      expect(resend).toHaveBeenCalledTimes(1);
    });

    it('fails closed with 503 when Workers AI errors, answers unrecognisably, or the binding is missing', async () => {
      ai.run.mockRejectedValueOnce(new Error('3040: capacity exceeded'));
      expect((await notify({ channel: 'email' })).status).toBe(503);
      ai.run.mockResolvedValueOnce({ response: 'maybe?' });
      expect((await notify({ channel: 'email' })).status).toBe(503);
      const missing = await notify({ channel: 'email' }, env({ AI: undefined }));
      expect(missing.status).toBe(503);
      expect(missing.headers.get('Retry-After')).toBe('60');
      expect(resend).not.toHaveBeenCalled();
      expect(state.usage).toEqual([]);
    });

    it('push-only is unaffected: never moderated, delivered even with no AI binding', async () => {
      state.subs.add('u2');
      const res = await notify({ channel: 'push' }, env({ AI: undefined }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ sent: 1, failed: 0 });
      expect(ai.run).not.toHaveBeenCalled();
    });

    it('cost: skipped recipients and limit refusals never call the model', async () => {
      state.optouts.add('myapp:u2');
      expect(await (await notify({ channel: 'email' })).json()).toMatchObject({ skipped: 'unsubscribed' });
      state.members.add('cred:kid');
      expect(await (await notify({ channel: 'email', targetUserId: 'cred:kid' })).json()).toMatchObject({ skipped: 'no_address' });
      expect(await (await notify({ channel: 'email', targetUserId: 'u9' })).json()).toMatchObject({ skipped: 'not_member' });
      expect((await notify({ channel: 'email', url: 'https://evil.example/' })).status).toBe(400);
      state.optouts.clear();
      state.usage = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, target: 'u2' }));
      expect((await notify({ channel: 'email' })).status).toBe(429);
      expect(ai.run).not.toHaveBeenCalled();
    });

    it('cost: rejected attempts still count toward the per-minute limits, bounding model calls', async () => {
      unsafe();
      for (let i = 0; i < 10; i++) expect((await notify({ channel: 'email' })).status).toBe(422);
      expect((await notify({ channel: 'email' })).status).toBe(429); // 11th to the same recipient in a minute
      expect(ai.run).toHaveBeenCalledTimes(10);
    });
  });
});
