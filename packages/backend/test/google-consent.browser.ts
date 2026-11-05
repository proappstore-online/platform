import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, webkit, expect as browserExpect } from '@playwright/test';
import { Hono } from 'hono';
import { expect, it } from 'vitest';
import { mintSession } from '@proappstore/build-core';
import { sqliteD1 } from '../src/sqlite-d1';
import { makeEnv } from '../src/test-helpers';
import type { Env } from '../src/types';
import { googleCalendarRoutes } from '../src/routes/google-calendar';
import { beginGoogleOAuth } from '../src/lib/google-calendar-accounts';

for (const [engine, browserType] of Object.entries({ chromium, webkit })) for (const width of [320, 390]) {
  it(`${engine} ${width}px: sign in, read disclosure, select Calendar only, then leave for Google`, async () => {
    const db = sqliteD1();
    db.sql.exec(`INSERT INTO users (id,provider,provider_id,login,created_at,last_login_at) VALUES ('gh:1','github','1','person',1,1);
      INSERT INTO apps (id,creator_id,created_at) VALUES ('reference','gh:1',1);
      INSERT INTO submissions (id,app_id,creator_id,status,name,category,description,created_at) VALUES ('s','reference','gh:1','published','Meeting Notes','business','Reference fixture',1);`);
    db.sql.prepare(`INSERT INTO app_connectors (app_id,name,kind,modes,events,created_at,capabilities_json,disclosure_json) VALUES ('reference','calendar','google_calendar','["oauth"]','[]',1,?,?)`)
      .run(JSON.stringify(['calendar.read', 'meet.read']), JSON.stringify({ purpose: 'Show your selected meetings and related participant records.', audience: 'People you authorize in Meeting Notes can see saved records.', retention: 'Saved records are kept until you delete them in the app.', privacy_path: '/privacy', deletion_path: '/settings/data' }));
    const env = makeEnv({ DB: db, GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret', APP_SECRET_KEK: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=' }) as Env;
    const router = new Hono<{ Bindings: Env }>().route('/v1', googleCalendarRoutes);
    // Synthetic login only. Production credential verification has separate real-runtime tests.
    router.post('/v1/auth/credentials/login', async c => {
      const body = await c.req.json();
      if (body.login !== 'person@example.test' || body.password !== 'fixture-password') return c.json({ error: 'invalid credentials' }, 401);
      return c.json({ token: await mintSession({ uid: 'gh:1', roles: ['user'], auth_time: Math.floor(Date.now() / 1000), auth_method: 'password' }, env.SESSION_SIGNING_KEY) });
    });
    const temporary = await mkdtemp(join(tmpdir(), 'pas-consent-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(temporary, 'key.pem'), '-out', join(temporary, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    let API = 'https://127.0.0.1', googleUrl: URL | null = null;
    const server = createServer({ key: await readFile(join(temporary, 'key.pem')), cert: await readFile(join(temporary, 'cert.pem')) }, async (req, res) => {
      try {
        const chunks: Buffer[] = []; for await (const part of req) chunks.push(Buffer.from(part));
        const headers = new Headers(); for (const [key, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value);
        const response = await router.request(API + req.url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method ?? '') ? undefined : Buffer.concat(chunks) }, env);
        const destination = response.headers.get('Location');
        if (destination?.startsWith('https://accounts.google.com/')) {
          expect(response.status).toBe(302); googleUrl = new URL(destination);
          // Inspect the real handoff but never make a real Google OAuth request.
          res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<h1>Test Google authorization</h1>'); return;
        }
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
      } catch (error) { res.writeHead(500); res.end(String(error)); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    API = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
    env.APP_BASE = API;
    const start = await beginGoogleOAuth(env, 'reference', 'gh:1', '/callback', '/');
    const browser = await browserType.launch();
    try {
      // A test-only certificate; production always uses the API's trusted TLS origin.
      const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width, height: 844 }, colorScheme: width === 320 ? 'light' : 'dark' });
      await context.route('https://accounts.google.com/**', route => route.abort());
      const page = await context.newPage(), errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') console.error(engine, width, message.text()); });
      page.on('response', response => { if (response.status() >= 400) console.error(engine, width, response.status(), response.url()); });
      await page.goto(start.authorization_url);
      await browserExpect(page.getByRole('heading', { name: 'Connect Google to Meeting Notes' })).toBeVisible();
      await page.getByText('Use email or username', { exact: true }).click();
      await page.getByLabel('Email or username').fill('person@example.test');
      await page.getByLabel('Password', { exact: true }).fill('fixture-password');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await browserExpect(page.getByRole('heading', { name: 'Choose access' })).toBeVisible().catch(async error => { console.error(engine, width, await page.locator('body').innerText(), (await context.cookies()).map(c => c.name)); throw error; });
      await browserExpect(page.getByText('People you authorize in Meeting Notes can see saved records.')).toBeVisible();
      await browserExpect(page.getByText('Saved records are kept until you delete them in the app.')).toBeVisible();
      await browserExpect(page.getByRole('link', { name: 'Delete saved app data' })).toHaveAttribute('href', 'https://reference.proappstore.online/settings/data');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.getByRole('checkbox', { name: 'Read related Google Meet records' }).uncheck();
      await mkdir('artifacts/google-consent', { recursive: true });
      await page.screenshot({ path: `artifacts/google-consent/${engine}-${width}.png`, fullPage: true, caret: 'initial' });
      await page.getByRole('button', { name: 'Continue to Google' }).click();
      await browserExpect(page.getByRole('heading', { name: 'Test Google authorization' })).toBeVisible();
      expect(googleUrl!.searchParams.get('scope')).toContain('calendar.events.readonly');
      expect(googleUrl!.searchParams.get('scope')).not.toContain('meetings.space');
      expect(errors).toEqual([]);
      const receipt = db.sql.prepare('SELECT capabilities_json,consented_at FROM google_calendar_oauth_states').get()!;
      expect(receipt.capabilities_json).toBe('["calendar.read"]');
      expect(receipt.consented_at).toBeTypeOf('number');
    } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(temporary, { recursive: true, force: true }); }
  });
}
