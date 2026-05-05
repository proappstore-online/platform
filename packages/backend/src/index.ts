import { Hono } from 'hono';

interface Env {
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  SESSION_SIGNING_KEY?: string;
}

export const app = new Hono<{ Bindings: Env }>();

app.get('/', (c) => c.text('ProAppStore API'));
app.get('/health', (c) => c.json({ ok: true }));

const v1 = new Hono<{ Bindings: Env }>();

v1.get('/subscription', (c) => c.text('not implemented (skeleton)', 501));
v1.post('/checkout', (c) => c.text('not implemented (skeleton)', 501));
v1.post('/portal', (c) => c.text('not implemented (skeleton)', 501));
v1.get('/apps/:appId/license', (c) => c.text('not implemented (skeleton)', 501));
v1.post('/license/validate', (c) => c.text('not implemented (skeleton)', 501));

app.route('/v1', v1);

// Stripe webhook endpoint. Will verify signature with STRIPE_WEBHOOK_SECRET,
// then update D1 entitlements based on the event type. Stub for now.
app.post('/webhooks/stripe', (c) => c.text('not implemented (skeleton)', 501));

export default app;
