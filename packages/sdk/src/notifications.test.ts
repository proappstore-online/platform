import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Notifications } from './notifications.js';

interface AuthLike {
  token: string | null;
  isSignedIn: boolean;
  handleUnauthorized: () => void;
  authenticatedFetch(input: string | URL, init?: RequestInit): Promise<Response>;
}

function fakeAuth(token: string | null): AuthLike {
  const auth: AuthLike = {
    token,
    isSignedIn: token !== null,
    handleUnauthorized: vi.fn(),
    async authenticatedFetch(input: string | URL, init: RequestInit = {}) {
      if (!auth.token) throw new Error('Not signed in.');
      const headers = { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${auth.token}` };
      return fetch(input, { ...init, headers });
    },
  };
  return auth;
}

describe('Notifications', () => {
  const originalFetch = globalThis.fetch;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('getVapidKey', () => {
    it('fetches and returns the public key', async () => {
      const auth = fakeAuth('tok');
      const notif = new Notifications('myapp', 'https://api.proappstore.online', auth);
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ publicKey: 'BXYZ123' }), { status: 200 }),
      );

      const key = await notif.getVapidKey();

      expect(key).toBe('BXYZ123');
      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.proappstore.online/v1/notifications/vapid-key');
    });

    it('caches the key after first fetch', async () => {
      const auth = fakeAuth('tok');
      const notif = new Notifications('myapp', 'https://api.proappstore.online', auth);
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ publicKey: 'BXYZ123' }), { status: 200 }),
      );

      await notif.getVapidKey();
      const key2 = await notif.getVapidKey();

      expect(key2).toBe('BXYZ123');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('throws on non-ok response', async () => {
      const auth = fakeAuth('tok');
      const notif = new Notifications('myapp', 'https://api.proappstore.online', auth);
      mockFetch.mockResolvedValueOnce(new Response('', { status: 500 }));

      await expect(notif.getVapidKey()).rejects.toThrow('Failed to fetch VAPID key: 500');
    });
  });

  describe('send', () => {
    it('sends POST with userId and payload', async () => {
      const auth = fakeAuth('tok_send');
      const notif = new Notifications('myapp', 'https://api.proappstore.online', auth);
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ sent: 1, failed: 0 }), { status: 200 }),
      );

      const result = await notif.send('user-123', { title: 'Hello', body: 'World' });

      expect(result).toEqual({ sent: 1, failed: 0 });
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.proappstore.online/v1/notifications/send');
      expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toBe('Bearer tok_send');
      const body = JSON.parse(init.body);
      expect(body).toEqual({
        appId: 'myapp',
        userId: 'user-123',
        title: 'Hello',
        body: 'World',
        url: undefined,
        icon: undefined,
        tag: undefined,
      });
    });

    it('passes optional fields', async () => {
      const auth = fakeAuth('tok_send');
      const notif = new Notifications('myapp', 'https://api.proappstore.online', auth);
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ sent: 1, failed: 0 }), { status: 200 }),
      );

      await notif.send('user-123', {
        title: 'Event',
        body: 'Tomorrow',
        url: '/events/1',
        icon: '/icon.png',
        tag: 'event',
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.url).toBe('/events/1');
      expect(body.icon).toBe('/icon.png');
      expect(body.tag).toBe('event');
    });

    it('throws on 401 and calls handleUnauthorized', async () => {
      const auth = fakeAuth('tok_expired');
      const notif = new Notifications('myapp', 'https://api.proappstore.online', auth);
      mockFetch.mockResolvedValueOnce(new Response('', { status: 401 }));

      await expect(notif.send('u1', { title: 'T', body: 'B' })).rejects.toThrow('Not signed in.');
      expect(auth.handleUnauthorized).toHaveBeenCalled();
    });

    it('throws on 403', async () => {
      const auth = fakeAuth('tok_notcreator');
      const notif = new Notifications('myapp', 'https://api.proappstore.online', auth);
      mockFetch.mockResolvedValueOnce(new Response('', { status: 403 }));

      await expect(notif.send('u1', { title: 'T', body: 'B' })).rejects.toThrow(
        'Only the app creator can send notifications.',
      );
    });

    it('throws on other non-ok status', async () => {
      const auth = fakeAuth('tok');
      const notif = new Notifications('myapp', 'https://api.proappstore.online', auth);
      mockFetch.mockResolvedValueOnce(new Response('', { status: 500 }));

      await expect(notif.send('u1', { title: 'T', body: 'B' })).rejects.toThrow('send failed: 500');
    });
  });

  describe('broadcast', () => {
    it('sends POST without userId', async () => {
      const auth = fakeAuth('tok_bc');
      const notif = new Notifications('myapp', 'https://api.proappstore.online', auth);
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ sent: 5, failed: 1 }), { status: 200 }),
      );

      const result = await notif.broadcast({ title: 'Update', body: 'New feature' });

      expect(result).toEqual({ sent: 5, failed: 1 });
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.appId).toBe('myapp');
      expect(body.userId).toBeUndefined();
      expect(body.title).toBe('Update');
      expect(body.body).toBe('New feature');
    });
  });

  describe('auth errors', () => {
    it('send throws "Not signed in." when no token', async () => {
      const auth = fakeAuth(null);
      const notif = new Notifications('myapp', 'https://api.proappstore.online', auth);

      await expect(notif.send('u1', { title: 'T', body: 'B' })).rejects.toThrow('Not signed in.');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('broadcast throws "Not signed in." when no token', async () => {
      const auth = fakeAuth(null);
      const notif = new Notifications('myapp', 'https://api.proappstore.online', auth);

      await expect(notif.broadcast({ title: 'T', body: 'B' })).rejects.toThrow('Not signed in.');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('subscribe', () => {
    function setupBrowserMocks() {
      const pushSub = {
        endpoint: 'https://push.example.com/sub1',
        toJSON: () => ({ keys: { p256dh: 'p256dh-val', auth: 'auth-val' } }),
        unsubscribe: vi.fn().mockResolvedValue(true),
      };
      const pushManager = {
        subscribe: vi.fn().mockResolvedValue(pushSub),
        getSubscription: vi.fn().mockResolvedValue(pushSub),
      };
      const registration = { pushManager };

      vi.stubGlobal('Notification', {
        permission: 'default',
        requestPermission: vi.fn().mockResolvedValue('granted'),
      });
      vi.stubGlobal('navigator', {
        serviceWorker: {
          register: vi.fn().mockResolvedValue(registration),
          ready: Promise.resolve(registration),
          getRegistration: vi.fn().mockResolvedValue(registration),
        },
      });

      return { pushSub, pushManager, registration };
    }

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('registers SW, subscribes push, and POSTs to backend', async () => {
      const { pushManager } = setupBrowserMocks();
      const auth = fakeAuth('tok_sub');
      const notif = new Notifications('myapp', 'https://api.proappstore.online', auth);

      // First call: getVapidKey, second call: POST subscribe
      mockFetch
        .mockResolvedValueOnce(new Response(JSON.stringify({ publicKey: 'BXYZ' }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      await notif.subscribe('/sw.js');

      expect(navigator.serviceWorker.register).toHaveBeenCalledWith('/sw.js');
      expect(pushManager.subscribe).toHaveBeenCalledWith({
        userVisibleOnly: true,
        applicationServerKey: expect.any(Uint8Array),
      });

      // Verify backend POST
      const [url, init] = mockFetch.mock.calls[1];
      expect(url).toBe('https://api.proappstore.online/v1/notifications/subscribe');
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body);
      expect(body).toEqual({
        appId: 'myapp',
        endpoint: 'https://push.example.com/sub1',
        p256dh: 'p256dh-val',
        auth: 'auth-val',
      });
    });

    it('throws when not signed in', async () => {
      setupBrowserMocks();
      const auth = fakeAuth(null);
      const notif = new Notifications('myapp', 'https://api.proappstore.online', auth);

      await expect(notif.subscribe()).rejects.toThrow('Not signed in.');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('throws when permission is denied', async () => {
      setupBrowserMocks();
      vi.stubGlobal('Notification', {
        permission: 'default',
        requestPermission: vi.fn().mockResolvedValue('denied'),
      });
      const auth = fakeAuth('tok');
      const notif = new Notifications('myapp', 'https://api.proappstore.online', auth);

      await expect(notif.subscribe()).rejects.toThrow('Notification permission denied.');
    });

    it('rolls back browser subscription when backend POST fails', async () => {
      const { pushSub } = setupBrowserMocks();
      const auth = fakeAuth('tok');
      const notif = new Notifications('myapp', 'https://api.proappstore.online', auth);

      mockFetch
        .mockResolvedValueOnce(new Response(JSON.stringify({ publicKey: 'BXYZ' }), { status: 200 }))
        .mockResolvedValueOnce(new Response('error', { status: 500 }));

      await expect(notif.subscribe()).rejects.toThrow('subscribe failed: 500');
      expect(pushSub.unsubscribe).toHaveBeenCalled();
    });

    it('rolls back browser subscription and calls handleUnauthorized on 401', async () => {
      const { pushSub } = setupBrowserMocks();
      const auth = fakeAuth('tok_expired');
      const notif = new Notifications('myapp', 'https://api.proappstore.online', auth);

      mockFetch
        .mockResolvedValueOnce(new Response(JSON.stringify({ publicKey: 'BXYZ' }), { status: 200 }))
        .mockResolvedValueOnce(new Response('', { status: 401 }));

      await expect(notif.subscribe()).rejects.toThrow('Not signed in.');
      expect(pushSub.unsubscribe).toHaveBeenCalled();
      expect(auth.handleUnauthorized).toHaveBeenCalled();
    });
  });

  describe('unsubscribe', () => {
    function setupBrowserMocks(hasSub: boolean) {
      const pushSub = hasSub ? {
        endpoint: 'https://push.example.com/sub1',
        unsubscribe: vi.fn().mockResolvedValue(true),
      } : null;
      const registration = {
        pushManager: {
          getSubscription: vi.fn().mockResolvedValue(pushSub),
        },
      };
      vi.stubGlobal('navigator', {
        serviceWorker: {
          getRegistration: vi.fn().mockResolvedValue(registration),
        },
      });
      return { pushSub, registration };
    }

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('calls backend first, then unsubscribes browser', async () => {
      const { pushSub } = setupBrowserMocks(true);
      const auth = fakeAuth('tok_unsub');
      const notif = new Notifications('myapp', 'https://api.proappstore.online', auth);

      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      await notif.unsubscribe();

      // Backend was called
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.proappstore.online/v1/notifications/unsubscribe');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({ endpoint: 'https://push.example.com/sub1' });

      // Browser subscription also unsubscribed
      expect(pushSub!.unsubscribe).toHaveBeenCalled();
    });

    it('throws when not signed in', async () => {
      setupBrowserMocks(true);
      const auth = fakeAuth(null);
      const notif = new Notifications('myapp', 'https://api.proappstore.online', auth);

      await expect(notif.unsubscribe()).rejects.toThrow('Not signed in.');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('does nothing when no browser subscription exists', async () => {
      setupBrowserMocks(false);
      const auth = fakeAuth('tok');
      const notif = new Notifications('myapp', 'https://api.proappstore.online', auth);

      await notif.unsubscribe();

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('isSubscribed', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('returns true when browser has a push subscription', async () => {
      vi.stubGlobal('navigator', {
        serviceWorker: {
          getRegistration: vi.fn().mockResolvedValue({
            pushManager: { getSubscription: vi.fn().mockResolvedValue({ endpoint: 'x' }) },
          }),
        },
      });
      const notif = new Notifications('myapp', 'https://api.proappstore.online', fakeAuth('tok'));
      expect(await notif.isSubscribed()).toBe(true);
    });

    it('returns false when no push subscription', async () => {
      vi.stubGlobal('navigator', {
        serviceWorker: {
          getRegistration: vi.fn().mockResolvedValue({
            pushManager: { getSubscription: vi.fn().mockResolvedValue(null) },
          }),
        },
      });
      const notif = new Notifications('myapp', 'https://api.proappstore.online', fakeAuth('tok'));
      expect(await notif.isSubscribed()).toBe(false);
    });

    it('returns false when no service worker registration', async () => {
      vi.stubGlobal('navigator', {
        serviceWorker: {
          getRegistration: vi.fn().mockResolvedValue(undefined),
        },
      });
      const notif = new Notifications('myapp', 'https://api.proappstore.online', fakeAuth('tok'));
      expect(await notif.isSubscribed()).toBe(false);
    });
  });

  describe('getPermission', () => {
    it('returns "denied" when Notification is not defined', () => {
      const auth = fakeAuth('tok');
      const notif = new Notifications('myapp', 'https://api.proappstore.online', auth);

      // In Node test environment, Notification is not defined
      expect(notif.getPermission()).toBe('denied');
    });

    it('returns Notification.permission when available', () => {
      vi.stubGlobal('Notification', { permission: 'granted' });
      const notif = new Notifications('myapp', 'https://api.proappstore.online', fakeAuth('tok'));
      expect(notif.getPermission()).toBe('granted');
      vi.unstubAllGlobals();
    });
  });

  describe('getServiceWorkerScript', () => {
    it('returns a non-empty string containing push and notificationclick handlers', () => {
      const script = Notifications.getServiceWorkerScript();

      expect(typeof script).toBe('string');
      expect(script.length).toBeGreaterThan(0);
      expect(script).toContain("self.addEventListener('push'");
      expect(script).toContain("self.addEventListener('notificationclick'");
      expect(script).toContain('showNotification');
      expect(script).toContain('clients.openWindow');
    });
  });
});
