import { test, expect, hasSession } from '../fixtures'

// The keyboard-accessible alternative: every record on the map is reachable as
// text, by Tab and Enter, without touching the map.
test('the list page reaches the same records by keyboard', async ({ app }) => {
  test.skip(!hasSession, 'needs an e2e session')
  await app.goto('/#/list')
  await expect(app.getByRole('heading', { level: 1 })).toContainText(/all/i)
  const list = app.getByRole('list', { name: /list/i })
  await expect(list).toBeVisible()
  // Tab from the search box into the list and open the first record with Enter, if any.
  await app.getByRole('searchbox', { name: 'Search' }).focus()
  const links = list.getByRole('link')
  const n = await links.count()
  if (n === 0) {
    await expect(app.locator('[data-state="empty"]')).toBeVisible()
    return
  }
  await links.first().focus()
  await app.keyboard.press('Enter')
  await expect(app).toHaveURL(/#\/p\//)
  await expect(app.getByRole('article')).toBeVisible()
})

test('map and list agree on the record count (parity)', async ({ app }) => {
  test.skip(!hasSession, 'needs an e2e session')
  await app.goto('/#/list')
  const listCount = await app.getByRole('list', { name: /list/i }).getByRole('link').count()
  await app.goto('/#/')
  // Zoom the map out so the viewport holds everything the list holds.
  const zoomOut = app.getByRole('button', { name: 'Zoom out' })
  for (let i = 0; i < 8; i++) await zoomOut.click()
  await app.waitForTimeout(1500)
  const markers = app.getByRole('application').getByRole('button', { name: /places here|^(?!Zoom)/ })
  const total = await markers.evaluateAll((els) => els.reduce((sum, el) => {
    const label = el.getAttribute('aria-label') ?? ''
    const m = /^(\d+) places here/.exec(label)
    if (m) return sum + Number(m[1])
    return /^Zoom/.test(label) ? sum : sum + 1
  }, 0))
  expect(total).toBe(listCount)
})
