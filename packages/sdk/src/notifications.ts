interface AuthLike {
  token: string | null;
  isSignedIn: boolean;
  handleUnauthorized(): void;
  authenticatedFetch(input: string | URL, init?: RequestInit): Promise<Response>;
}

export interface NotificationPayload {
  title: string;
  body: string;
  icon?: string;
  url?: string;
  tag?: string;
}

export interface SendResult {
  sent: number;
  failed: number;
}

/**
 * Web Push notifications — subscribe users, send targeted or broadcast pushes.
 * Backed by the PAS API + VAPID + W3C Push API.
 */
export class Notifications {
  private vapidKeyCache: string | null = null;

  constructor(
    private readonly appId: string,
    private readonly apiBase: string,
    private readonly auth: AuthLike,
  ) {}

  /** Fetch the server's VAPID public key (cached after first call). */
  async getVapidKey(): Promise<string> {
    if (this.vapidKeyCache) return this.vapidKeyCache;
    const res = await fetch(`${this.apiBase}/v1/notifications/vapid-key`);
    if (!res.ok) throw new Error(`Failed to fetch VAPID key: ${res.status}`);
    const data = (await res.json()) as { publicKey: string };
    this.vapidKeyCache = data.publicKey;
    return data.publicKey;
  }

  /** Request permission, register the service worker, and subscribe to push. */
  async subscribe(swPath = '/sw.js'): Promise<void> {
    if (!this.auth.isSignedIn) throw new Error('Not signed in.');

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('Notification permission denied.');

    const vapidKey = await this.getVapidKey();
    await navigator.serviceWorker.register(swPath);
    const registration = await navigator.serviceWorker.ready;

    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidKey) as BufferSource,
    });

    const keys = subscription.toJSON().keys!;
    const res = await this.auth.authenticatedFetch(`${this.apiBase}/v1/notifications/subscribe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        appId: this.appId,
        endpoint: subscription.endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
      }),
    });

    if (!res.ok) {
      // Roll back browser subscription so isSubscribed() stays consistent
      await subscription.unsubscribe();
      if (res.status === 401) {
        this.auth.handleUnauthorized();
        throw new Error('Not signed in.');
      }
      throw new Error(`subscribe failed: ${res.status}`);
    }
  }

  /** Unsubscribe from push notifications (browser + backend). */
  async unsubscribe(): Promise<void> {
    if (!this.auth.isSignedIn) throw new Error('Not signed in.');

    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();

    if (subscription) {
      const endpoint = subscription.endpoint;

      // Backend first — if it fails, browser sub stays active so user can retry
      await this.auth.authenticatedFetch(`${this.apiBase}/v1/notifications/unsubscribe`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ endpoint }),
      });

      await subscription.unsubscribe();
    }
  }

  /** Check if the user is currently subscribed to push. */
  async isSubscribed(): Promise<boolean> {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) return false;
    const subscription = await registration.pushManager.getSubscription();
    return subscription !== null;
  }

  /** Return the current Notification permission state. */
  getPermission(): NotificationPermission {
    return typeof Notification !== 'undefined' ? Notification.permission : 'denied';
  }

  /** Send a push notification to a specific user (must be app creator). */
  async send(userId: string, payload: NotificationPayload): Promise<SendResult> {
    return this._send({ ...payload, userId });
  }

  /** Broadcast a push notification to all subscribers (must be app creator). */
  async broadcast(payload: NotificationPayload): Promise<SendResult> {
    return this._send(payload);
  }

  /**
   * Peer-to-peer push: notify another user in the same app.
   * Caller must be subscribed to the app (no creator check).
   * Rate-limited: 30 per minute per app.
   */
  async notifyUser(userId: string, payload: NotificationPayload): Promise<SendResult> {
    const res = await this.auth.authenticatedFetch(`${this.apiBase}/v1/notifications/notify-user`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        appId: this.appId,
        targetUserId: userId,
        title: payload.title,
        body: payload.body,
        url: payload.url,
        icon: payload.icon,
        tag: payload.tag,
      }),
    });

    if (res.status === 401) {
      this.auth.handleUnauthorized();
      throw new Error('Not signed in.');
    }
    if (res.status === 429) throw new Error('Rate limit exceeded: max 30 notifications per minute.');
    if (!res.ok) throw new Error(`notifyUser failed: ${res.status}`);

    return (await res.json()) as SendResult;
  }

  private async _send(payload: NotificationPayload & { userId?: string }): Promise<SendResult> {
    const res = await this.auth.authenticatedFetch(`${this.apiBase}/v1/notifications/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        appId: this.appId,
        userId: payload.userId,
        title: payload.title,
        body: payload.body,
        url: payload.url,
        icon: payload.icon,
        tag: payload.tag,
      }),
    });

    if (res.status === 401) {
      this.auth.handleUnauthorized();
      throw new Error('Not signed in.');
    }
    if (res.status === 403) throw new Error('Only the app creator can send notifications.');
    if (!res.ok) throw new Error(`send failed: ${res.status}`);

    return (await res.json()) as SendResult;
  }

  /**
   * Returns the service worker push event handler script as a string.
   * Apps should save this as their sw.js (or append to an existing one).
   */
  static getServiceWorkerScript(): string {
    return `
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(
    self.registration.showNotification(data.title || 'Notification', {
      body: data.body || '',
      icon: data.icon || '/icon-192.png',
      tag: data.tag || undefined,
      data: { url: data.url },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url;
  if (url) {
    event.waitUntil(clients.openWindow(url));
  }
});
`.trim();
  }
}

/** Convert a URL-safe base64 VAPID key to Uint8Array for PushManager. */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}
