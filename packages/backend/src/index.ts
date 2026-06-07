import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { HttpError } from './lib/auth.js';
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
import { analyticsRoutes } from './routes/analytics.js';
import { appsRoutes } from './routes/apps.js';
import { listingsRoutes } from './routes/listings.js';
import { usageRoutes } from './routes/usage.js';
import { connectRoutes } from './routes/connect.js';
import { payoutsRoutes } from './routes/payouts.js';
import { domainRoutes } from './routes/domains.js';
import { emailRoutes } from './routes/email.js';
import { webhookConfigRoutes } from './routes/webhooks-config.js';
import { logsRoutes } from './routes/logs.js';
import { toolsRoutes } from './routes/tools.js';
import { secretsRoutes } from './routes/secrets.js';
import { keysRoutes } from './routes/keys.js';
import { authRoutes } from './routes/auth.js';
import { servicesRoutes } from './routes/services.js';
import { engagementRoutes } from './routes/engagements.js';
import { payoutCronRoutes } from './routes/payout-cron.js';
import { teamRoutes } from './routes/teams.js';

export const app = new Hono<{ Bindings: Env }>();

// CORS origin check — shared between middleware and onError handler
function corsOrigin(origin: string | undefined): string | null {
  if (!origin) return null;
  try {
    const host = new URL(origin).hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1') return origin;
    if (host.endsWith('.proappstore.online') || host === 'proappstore.online') return origin;
    if (host.endsWith('.freeappstore.online') || host === 'freeappstore.online') return origin;
    if (host.endsWith('.pages.dev') && host.includes('proappstore')) return origin;
    return null;
  } catch {
    return null;
  }
}

app.use(
  '*',
  cors({
    origin: corsOrigin,
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type'],
    maxAge: 600,
  }),
);

app.onError((err, c) => {
  const status = err instanceof HttpError ? err.status as ContentfulStatusCode : 500;
  const body = err instanceof HttpError
    ? { error: err.message }
    : { error: 'Internal server error' };

  if (!(err instanceof HttpError)) console.error('Unhandled error:', err);

  // CORS middleware doesn't run on error responses, so set headers here
  const origin = corsOrigin(c.req.header('Origin'));
  const res = c.json(body, status);
  if (origin) {
    res.headers.set('Access-Control-Allow-Origin', origin);
    res.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  }
  return res;
});

app.get('/', (c) => c.json({ ok: true, service: 'proappstore-api' }));
app.get('/health', (c) => c.json({ ok: true }));

const v1 = new Hono<{ Bindings: Env }>();
v1.route('/', authRoutes);
v1.route('/', subscriptionRoutes);
v1.route('/', licenseRoutes);
v1.route('/', storageRoutes);
v1.route('/', mapsRoutes);
v1.route('/', provisionRoutes);
v1.route('/', notificationRoutes);
v1.route('/', smsRoutes);
v1.route('/', aiRoutes);
v1.route('/', submissionRoutes);
v1.route('/', appsRoutes);
v1.route('/', analyticsRoutes);
v1.route('/', listingsRoutes);
v1.route('/', usageRoutes);
v1.route('/', connectRoutes);
v1.route('/', payoutsRoutes);
v1.route('/', domainRoutes);
v1.route('/', emailRoutes);
v1.route('/', webhookConfigRoutes);
v1.route('/', logsRoutes);
v1.route('/', toolsRoutes);
v1.route('/', secretsRoutes);
v1.route('/', keysRoutes);
v1.route('/', servicesRoutes);
v1.route('/', engagementRoutes);
v1.route('/', payoutCronRoutes);
v1.route('/', teamRoutes);
app.route('/v1', v1);

// Stripe webhook is outside /v1 — it's not user-facing API
app.route('/', webhookRoutes);

export default app;
