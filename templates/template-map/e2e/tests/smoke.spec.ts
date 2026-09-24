import { test, expect, hasSession } from '../fixtures'

// Deployment smoke: the live app serves, boots without page errors, and shows
// either the sign-in gate or the map.
test('the deployed app boots without page errors', async ({ app, pageErrors }) => {
  await expect(app.locator('#root')).not.toBeEmpty()
  expect(pageErrors).toEqual([])
})

test('signed in: the map, its controls and the list alternative are present', async ({ app }) => {
  test.skip(!hasSession, 'needs an e2e session')
  const map = app.getByRole('application', { name: /map/i })
  await expect(map).toBeVisible()
  await expect(app.getByRole('button', { name: 'Zoom in' })).toBeVisible()
  await expect(app.getByRole('search')).toBeVisible()
  await expect(app.getByRole('link', { name: 'Full list' })).toBeVisible()
})
