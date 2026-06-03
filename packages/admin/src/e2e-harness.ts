/**
 * Playwright E2E harness injected into every agent-built app at deploy time
 * (like the deploy workflow). It drives the REAL deployed app in a headless
 * browser — the behavioural gate that `tsc`/build cannot be: it catches apps
 * that compile but white-screen, crash on boot, or don't actually work.
 *
 * Auth re-uses the SDK's own `#fas_session=<token>` callback path with a
 * platform FIXTURE session (the `PAS_E2E_SESSION_TOKEN` Actions secret), so
 * there is NO test-bypass code in apps or the SDK — E2E exercises the exact
 * production sign-in path. Without a token, auth-gated specs skip and only the
 * unauthenticated smoke runs, so a deploy is never blocked just because the
 * fixture isn't provisioned yet.
 *
 * Convention: apps mount to `#root`. QA agents add per-feature specs under
 * `e2e/specs/`; this harness's config + fixtures + baseline smoke are injected
 * only when absent, so authored specs and harness edits survive re-deploys.
 */

/** Specs authored by the QA agent live here; the baseline smoke is skipped when any exist. */
export const E2E_SPEC_PREFIX = 'e2e/specs/';

const PACKAGE_JSON = `{
  "name": "app-e2e",
  "private": true,
  "version": "0.0.0",
  "description": "Playwright behavioural tests for this app (run in CI against the live deploy).",
  "scripts": {
    "test": "playwright test"
  },
  "devDependencies": {
    "@playwright/test": "^1.49.1"
  }
}
`;

const PLAYWRIGHT_CONFIG = `import { defineConfig, devices } from '@playwright/test';

// Drives the LIVE deployed app (E2E_BASE_URL), set by the CI e2e job to
// https://<app>.proappstore.online. Run locally with:
//   E2E_BASE_URL=https://<app>.proappstore.online npx playwright test
export default defineConfig({
  testDir: './specs',
  timeout: 45000,
  expect: { timeout: 15000 },
  retries: 1,
  forbidOnly: true,
  reporter: [['github'], ['list'], ['json', { outputFile: 'results.json' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
`;

const FIXTURES = `import { test as base, expect, type Page } from '@playwright/test';

// A fixture session token for a throwaway E2E user, injected by the CI e2e job
// (PAS_E2E_SESSION_TOKEN). It is a normal, revocable platform session — NOT a
// bypass: the app signs in via the SDK's real OAuth-callback path below.
const SESSION_TOKEN = process.env.E2E_SESSION_TOKEN || '';
export const hasSession = SESSION_TOKEN.length > 0;

// Navigate with a few retries so a just-provisioned custom domain that is still
// warming up (Cloudflare first-deploy propagation) does not read as a failure.
async function gotoWithRetry(page: Page, path: string) {
  let lastErr: unknown;
  // ~60s budget: a brand-new app's custom domain can still be warming up
  // (Cloudflare first-deploy DNS/route propagation) for the first deploy.
  for (let i = 0; i < 10; i++) {
    try {
      const res = await page.goto(path, { waitUntil: 'domcontentloaded', timeout: 20000 });
      if (res && res.status() < 500) return;
      lastErr = new Error('HTTP ' + (res ? res.status() : 'no response'));
    } catch (e) {
      lastErr = e;
    }
    await page.waitForTimeout(6000);
  }
  throw lastErr;
}

// 'app' fixture: a Page already past the sign-in wall when a fixture session is
// configured. The SDK's auth.init() reads fas_session from the URL hash, calls
// /v1/auth/me, persists the session, and clears the hash — the SAME path a real
// GitHub/Google OAuth callback uses. Without a token, returns an un-authed page
// (the sign-in screen) so unauthenticated smokes still run.
export const test = base.extend<{ app: Page; pageErrors: string[] }>({
  pageErrors: async ({}, use) => { await use([]); },
  app: async ({ page, pageErrors }, use) => {
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    const target = hasSession ? '/#fas_session=' + encodeURIComponent(SESSION_TOKEN) : '/';
    await gotoWithRetry(page, target);
    await page.waitForLoadState('networkidle').catch(() => {});
    await use(page);
  },
});

export { expect };
`;

const SMOKE_SPEC = `import { test, expect, hasSession } from '../fixtures';

// Baseline behavioural smoke. tsc + a green build can't tell you the app boots —
// this opens it in a real browser and checks it mounts and doesn't crash. QA
// agents add per-feature specs alongside this file; they run against the same
// live deploy with the same signed-in fixture.
test('app boots and mounts without crashing', async ({ app, pageErrors }) => {
  await expect(app.locator('#root')).not.toBeEmpty();
  expect(pageErrors).toEqual([]);
});

test('signed-in: lands past the sign-in wall', async ({ app }) => {
  test.skip(!hasSession, 'no E2E fixture session configured (set PAS_E2E_SESSION_TOKEN)');
  // The app cleared the auth hash on init; a signed-in app should not present a
  // sign-in call-to-action as its primary content.
  await expect(app.locator('#root')).not.toBeEmpty();
  await expect(app.getByRole('button', { name: /sign in/i })).toHaveCount(0);
});
`;

/**
 * The harness file map. provisionApp injects each entry only when that exact
 * path is absent from the authored bundle (so QA specs + harness edits survive),
 * and skips the baseline smoke when the bundle already has specs under e2e/specs/.
 */
export function e2eHarnessFiles(): Record<string, string> {
  return {
    'e2e/package.json': PACKAGE_JSON,
    'e2e/playwright.config.ts': PLAYWRIGHT_CONFIG,
    'e2e/fixtures.ts': FIXTURES,
    'e2e/specs/smoke.spec.ts': SMOKE_SPEC,
  };
}
