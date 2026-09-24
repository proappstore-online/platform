import { test, expect, hasSession } from '../fixtures'

// Mobile layout: the map fills the screen, the records are behind a bottom-sheet
// toggle, and the desktop side panel is not what renders.
test('mobile: bottom sheet toggles the record list over the map', async ({ app }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'mobile project only')
  test.skip(!hasSession, 'needs an e2e session')
  const toggle = app.getByRole('button', { name: /here|list/i })
  await expect(toggle).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(app.locator('#map-sheet')).toBeVisible()
})

test('desktop: the side panel is open beside the map', async ({ app }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'desktop project only')
  test.skip(!hasSession, 'needs an e2e session')
  await expect(app.locator('#map-sheet')).toBeVisible()
  await expect(app.getByRole('button', { name: /here|list/i })).toBeHidden()
})
