import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from '../types.js';
import { requireAppOwner, HttpError } from '../lib/auth.js';

export const webhookConfigRoutes = new Hono<{ Bindings: Env }>();

const SUPPORTED_EVENTS = [
  'notification.sent',
  'storage.uploaded',
];

/** GET /v1/apps/:appId/webhooks — list registered webhooks. */
webhookConfigRoutes.get('/apps/:appId/webhooks', async (c) => {
  try {
    const appId = c.req.param('appId');
    await requireAppOwner(c, appId);

    const { results } = await c.env.DB.prepare(
      'SELECT id, event, url, active, created_at FROM app_webhooks WHERE app_id = ?1 ORDER BY created_at DESC',
    ).bind(appId).all<{ id: string; event: string; url: string; active: number; created_at: number }>();

    return c.json({ webhooks: results });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

/** POST /v1/apps/:appId/webhooks — register a webhook. Returns the signing secret. */
webhookConfigRoutes.post('/apps/:appId/webhooks', async (c) => {
  try {
    const appId = c.req.param('appId');
    await requireAppOwner(c, appId);

    const { event, url } = await c.req.json<{ event: string; url: string }>();
    if (!event || !url) return c.text('missing required fields: event, url', 400);
    if (!SUPPORTED_EVENTS.includes(event)) {
      return c.text(`unsupported event. supported: ${SUPPORTED_EVENTS.join(', ')}`, 400);
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return c.text('invalid URL', 400);
    }
    if (parsed.protocol !== 'https:') return c.text('webhook URL must use HTTPS', 400);
    const host = parsed.hostname.toLowerCase();
    // SSRF guard. Block private/loopback/link-local ranges comprehensively, plus
    // IP-literal encodings that dodge dotted-quad prefix checks: ALL IPv6
    // literals, bare-decimal IPs (e.g. https://2130706433/ = 127.0.0.1), and
    // hex/octal IPs. Covers the whole 127/8 and 169.254/16, not just one address.
    const isIpv6Literal = host.startsWith('[');
    const isEncodedIp = /^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host);
    if (isIpv6Literal || isEncodedIp ||
        host === 'localhost' || host === '0.0.0.0' || host.endsWith('.local') ||
        host.startsWith('127.') || host.startsWith('10.') || host.startsWith('192.168.') ||
        host.startsWith('169.254.') || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
      return c.text('webhook URL must not point to private/internal addresses', 400);
    }

    const id = crypto.randomUUID();
    const secret = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');

    await c.env.DB.prepare(
      'INSERT INTO app_webhooks (id, app_id, event, url, secret) VALUES (?1, ?2, ?3, ?4, ?5)',
    ).bind(id, appId, event, url, secret).run();

    return c.json({ id, secret });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

/** DELETE /v1/apps/:appId/webhooks/:id — remove a webhook. */
webhookConfigRoutes.delete('/apps/:appId/webhooks/:id', async (c) => {
  try {
    const appId = c.req.param('appId');
    await requireAppOwner(c, appId);
    const webhookId = c.req.param('id');

    const result = await c.env.DB.prepare(
      'DELETE FROM app_webhooks WHERE id = ?1 AND app_id = ?2',
    ).bind(webhookId, appId).run();

    if (!result.meta.changes) return c.text('webhook not found', 404);
    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

/** POST /v1/apps/:appId/webhooks/:id/test — fire a test event. */
webhookConfigRoutes.post('/apps/:appId/webhooks/:id/test', async (c) => {
  try {
    const appId = c.req.param('appId');
    await requireAppOwner(c, appId);
    const webhookId = c.req.param('id');

    const hook = await c.env.DB.prepare(
      'SELECT url, secret, event FROM app_webhooks WHERE id = ?1 AND app_id = ?2',
    ).bind(webhookId, appId).first<{ url: string; secret: string; event: string }>();
    if (!hook) return c.text('webhook not found', 404);

    const payload = { test: true, event: hook.event, appId, timestamp: Date.now() };
    const body = JSON.stringify(payload);
    const encoder = new TextEncoder();

    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(hook.secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
    const signature = Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    let status: number;
    let responseBody: string;
    try {
      const res = await fetch(hook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': signature,
          'X-Webhook-Event': hook.event,
        },
        body,
      });
      status = res.status;
      responseBody = await res.text().catch(() => '');
    } catch (err: any) {
      return c.json({ status: 0, body: err?.message ?? 'network error' });
    }

    return c.json({ status, body: responseBody.slice(0, 1000) });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});
