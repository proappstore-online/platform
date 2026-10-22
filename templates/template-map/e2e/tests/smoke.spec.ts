import { test, expect } from '../fixtures';

// Deployment smoke, and the worked example of PAS signed-in testing (see the
// comment at the top of ../fixtures.ts: the signed-in session is minted from the
// CI job's OIDC token - no stored credentials).

// (a) Unauthenticated: no token. A healthy response and a clean console.
test('anonymous: loads with a 2xx, renders, and logs no console errors', async ({ anonApp, status, pageErrors, consoleErrors }) => {
  expect(status.value, 'HTTP status of the app URL').toBeGreaterThanOrEqual(200);
  expect(status.value, 'HTTP status of the app URL').toBeLessThan(300);
  await expect(anonApp.locator('#root')).not.toBeEmpty();
  expect(pageErrors).toEqual([]);
  expect(consoleErrors.filter((m) => !/favicon/i.test(m))).toEqual([]);
});

// (b) Signed in: the authenticated pages work - here, the map and its controls.
test('signed in: the map, its controls and the list alternative are present', async ({ signedInApp, pageErrors }) => {
  const map = signedInApp.getByRole('application', { name: /map/i });
  await expect(map).toBeVisible();
  await expect(signedInApp.getByRole('button', { name: 'Zoom in' })).toBeVisible();
  await expect(signedInApp.getByRole('search')).toBeVisible();
  await expect(signedInApp.getByRole('link', { name: 'Full list' })).toBeVisible();
  expect(pageErrors).toEqual([]);
});
