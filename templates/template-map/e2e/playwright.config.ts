import { defineConfig, devices } from '@playwright/test'

// Drives the LIVE deployed app. The deploy workflow sets E2E_BASE_URL to
// https://<repo>.proappstore.online; default to the same host for local runs.
const baseURL = process.env.E2E_BASE_URL || 'https://APPNAME.proappstore.online'

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // The deploy workflow's "Publish test results" step reads ./results.json.
  reporter: [['json', { outputFile: 'results.json' }], ['list']],
  use: { baseURL, trace: 'on-first-retry' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
})
