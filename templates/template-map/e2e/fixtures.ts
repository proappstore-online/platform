import { test as base, expect, type Page } from '@playwright/test'

// A session for a throwaway e2e account, injected by the deploy job
// (PAS_E2E_SESSION_TOKEN, or minted keylessly from the workflow's OIDC token via
// POST /v1/auth/exchange/oidc — see docs/publishing-flow.md). A normal, revocable
// platform session: the app signs in through the SDK's real callback path.
const SESSION_TOKEN = process.env.E2E_SESSION_TOKEN || ''
export const hasSession = SESSION_TOKEN.length > 0
export const API = process.env.E2E_API_BASE || 'https://api.proappstore.online'
export const APP_ID = process.env.E2E_APP_ID || new URL(process.env.E2E_BASE_URL || 'https://APPNAME.proappstore.online').hostname.split('.')[0]!

async function gotoWithRetry(page: Page, path: string) {
  let lastErr: unknown
  for (let i = 0; i < 10; i++) {
    try {
      const res = await page.goto(path, { waitUntil: 'domcontentloaded', timeout: 20000 })
      if (res && res.status() < 500) return
      lastErr = new Error('HTTP ' + (res ? res.status() : 'no response'))
    } catch (e) { lastErr = e }
    await page.waitForTimeout(6000)
  }
  throw lastErr
}

export const test = base.extend<{ app: Page; pageErrors: string[] }>({
  pageErrors: async ({}, use) => { await use([]) },
  app: async ({ page, pageErrors }, use) => {
    page.on('pageerror', (e) => pageErrors.push(String(e)))
    await gotoWithRetry(page, hasSession ? '/#pas_session=' + encodeURIComponent(SESSION_TOKEN) : '/')
    await page.waitForLoadState('networkidle').catch(() => {})
    await use(page)
  },
})

export { expect }
