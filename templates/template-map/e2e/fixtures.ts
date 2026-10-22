import { test as base, expect, type Page } from '@playwright/test';

// ── How signed-in testing works on PAS ───────────────────────────────────────
// There are NO stored credentials here: no password, no pasted token, no CI
// secret. A signed-in test needs a session for a throwaway E2E account, and the
// platform mints one on demand by exchanging the CI job's GitHub OIDC token:
//
//   POST https://api.proappstore.online/v1/auth/exchange/oidc
//   Authorization: Bearer <GitHub Actions OIDC token, audience = the API origin>
//   -> { sessionToken }          a real, revocable, 4-hour platform session
//
// A platform admin allows this once per repository by creating an OIDC session
// grant (docs/publishing-flow.md); revoke the grant and the next run is refused.
// The e2e job runs with 'id-token: write', so GitHub exposes
// ACTIONS_ID_TOKEN_REQUEST_URL / _TOKEN to this process and we can mint below.
//
// For a laptop run, set E2E_SESSION_TOKEN yourself (a session from 'pas login');
// it wins over the OIDC exchange. With neither, signed-in specs skip and the
// anonymous checks still run.
//
// The token is never a bypass: the app is handed it through the SDK's ordinary
// '#pas_session=' callback, exactly as after a real GitHub/Google sign-in.
const API_ORIGIN = process.env.E2E_API_BASE || 'https://api.proappstore.online';
export const API = API_ORIGIN;
export const APP_ID = process.env.E2E_APP_ID || new URL(process.env.E2E_BASE_URL || 'https://APPNAME.proappstore.online').hostname.split('.')[0]!;
const OIDC_AVAILABLE = !!(process.env.ACTIONS_ID_TOKEN_REQUEST_URL && process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN);

/** True when a signed-in session is obtainable (it may still be refused at mint time). */
export const hasSession = !!process.env.E2E_SESSION_TOKEN || OIDC_AVAILABLE;

export interface TestSession { token: string | null; reason: string }

let sessionOnce: Promise<TestSession> | undefined;

/** Mint (once per worker) the test session. Never throws, never logs the token. */
export function testSession(): Promise<TestSession> {
  sessionOnce ??= mintSession();
  return sessionOnce;
}

async function mintSession(): Promise<TestSession> {
  if (process.env.E2E_SESSION_TOKEN) return { token: process.env.E2E_SESSION_TOKEN, reason: 'E2E_SESSION_TOKEN' };
  if (!OIDC_AVAILABLE) return { token: null, reason: 'no E2E_SESSION_TOKEN and not running in GitHub Actions with id-token: write' };
  try {
    // 1. Ask GitHub for an OIDC token whose audience is the platform API.
    const idRes = await fetch(process.env.ACTIONS_ID_TOKEN_REQUEST_URL + '&audience=' + encodeURIComponent(API_ORIGIN), {
      headers: { Authorization: 'bearer ' + process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN },
    });
    if (!idRes.ok) return { token: null, reason: 'GitHub OIDC token request failed (HTTP ' + idRes.status + ')' };
    const { value } = (await idRes.json()) as { value?: string };
    // 2. Trade it for a platform session for the repository's granted E2E account.
    const exRes = await fetch(API_ORIGIN + '/v1/auth/exchange/oidc', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + value },
    });
    if (!exRes.ok) return { token: null, reason: 'OIDC session exchange refused (HTTP ' + exRes.status + ') - has an admin granted this repository an OIDC session grant?' };
    const { sessionToken } = (await exRes.json()) as { sessionToken?: string };
    return sessionToken ? { token: sessionToken, reason: 'OIDC exchange' } : { token: null, reason: 'OIDC exchange returned no sessionToken' };
  } catch (e) {
    return { token: null, reason: 'OIDC exchange error: ' + String(e) };
  }
}

// Navigate with a few retries so a just-provisioned custom domain that is still
// warming up (Cloudflare first-deploy propagation) does not read as a failure.
// Returns the final HTTP status so the caller can assert it is 2xx.
async function gotoWithRetry(page: Page, path: string): Promise<number> {
  let lastErr: unknown;
  // ~60s budget: a brand-new app's custom domain can still be warming up
  // (Cloudflare first-deploy DNS/route propagation) for the first deploy.
  for (let i = 0; i < 10; i++) {
    try {
      const res = await page.goto(path, { waitUntil: 'domcontentloaded', timeout: 20000 });
      if (res && res.status() < 500) return res.status();
      lastErr = new Error('HTTP ' + (res ? res.status() : 'no response'));
    } catch (e) {
      lastErr = e;
    }
    await page.waitForTimeout(6000);
  }
  throw lastErr;
}

// Wait for the SPA to actually mount (#root gets content), NOT for the network to
// go idle: a PWA service worker or a long-lived connection can keep the network
// busy past the test timeout even when the app booted fine.
async function waitForMount(page: Page) {
  await page.locator('#root > *').first().waitFor({ state: 'attached', timeout: 15000 }).catch(() => {});
}

interface Fixtures {
  /** Anonymous page - never carries a token. Records the HTTP status and console errors. */
  anonApp: Page;
  /** Page already signed in via the test session; the test skips when none can be minted. */
  signedInApp: Page;
  /** Signed in when a session is obtainable, anonymous otherwise (kept for existing specs). */
  app: Page;
  pageErrors: string[];
  consoleErrors: string[];
  status: { value: number };
}

export const test = base.extend<Fixtures>({
  pageErrors: async ({}, use) => { await use([]); },
  consoleErrors: async ({}, use) => { await use([]); },
  status: async ({}, use) => { await use({ value: 0 }); },
  anonApp: async ({ page, pageErrors, consoleErrors, status }, use) => {
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    status.value = await gotoWithRetry(page, '/');
    await waitForMount(page);
    await use(page);
  },
  signedInApp: async ({ page, pageErrors, consoleErrors }, use, testInfo) => {
    const session = await testSession();
    testInfo.skip(!session.token, 'no test session: ' + session.reason);
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    // The SDK's auth.init() reads the session from the URL hash, verifies it with
    // /v1/auth/me, persists it and clears the hash - the SAME path a real OAuth
    // callback uses.
    await gotoWithRetry(page, '/#pas_session=' + encodeURIComponent(session.token!));
    await waitForMount(page);
    await use(page);
  },
  app: async ({ page, pageErrors }, use) => {
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    const session = await testSession();
    await gotoWithRetry(page, session.token ? '/#pas_session=' + encodeURIComponent(session.token) : '/');
    await waitForMount(page);
    await use(page);
  },
});

export { expect };
