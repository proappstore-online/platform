import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types.js';
import { subscriptionRoutes } from './routes/subscription.js';
import { licenseRoutes } from './routes/license.js';
import { storageRoutes } from './routes/storage.js';
import { mapsRoutes } from './routes/maps.js';
import { provisionRoutes } from './routes/provision.js';
import { webhookRoutes } from './routes/webhook.js';
import { notificationRoutes } from './routes/notifications.js';
import { smsRoutes } from './routes/sms.js';
import { aiRoutes } from './routes/ai.js';
import { submissionRoutes } from './routes/submissions.js';

export const app = new Hono<{ Bindings: Env }>();

// CORS — allow proappstore.online + freeappstore.online (shared identity)
app.use(
  '*',
  cors({
    origin: (origin) => {
      if (!origin) return null;
      try {
        const host = new URL(origin).hostname.toLowerCase();
        if (host === 'localhost' || host === '127.0.0.1') return origin;
        if (host.endsWith('.proappstore.online') || host === 'proappstore.online') return origin;
        if (host.endsWith('.freeappstore.online') || host === 'freeappstore.online') return origin;
        if (host.endsWith('.pages.dev')) return origin;
        return null;
      } catch {
        return null;
      }
    },
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type'],
    maxAge: 600,
  }),
);

app.get('/', (c) => c.json({ ok: true, service: 'proappstore-api' }));
app.get('/health', (c) => c.json({ ok: true }));

const v1 = new Hono<{ Bindings: Env }>();
v1.route('/', subscriptionRoutes);
v1.route('/', licenseRoutes);
v1.route('/', storageRoutes);
v1.route('/', mapsRoutes);
v1.route('/', provisionRoutes);
v1.route('/', notificationRoutes);
v1.route('/', smsRoutes);
v1.route('/', aiRoutes);
v1.route('/', submissionRoutes);
app.route('/v1', v1);

// Stripe webhook is outside /v1 — it's not user-facing API
app.route('/', webhookRoutes);

export default app;
