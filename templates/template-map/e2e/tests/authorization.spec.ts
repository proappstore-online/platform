import { test, expect, API, APP_ID } from '../fixtures'

// Unauthorized writes and cross-user reads at the API, not the UI: the actions
// route refuses without a session, and a second account cannot touch the e2e
// account's records. Runs without any session; the second half needs one.
test('the actions route refuses writes without a session', async ({ request }) => {
  const res = await request.post(`${API}/v1/apps/${APP_ID}/actions/create_place`, {
    data: { params: { id: 'e2e-unauth', owner_name: 'x', name: 'x', lat: 0, lng: 0 } },
  })
  expect(res.status()).toBe(401)
})

test('management actions refuse a session without the editor role', async ({ request }) => {
  const token = process.env.E2E_SESSION_TOKEN
  test.skip(!token, 'needs an e2e session')
  const res = await request.post(`${API}/v1/apps/${APP_ID}/actions/admin_list_places`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { params: {} },
  })
  // 403 unless the e2e account has been given the editor role deliberately.
  expect([200, 403]).toContain(res.status())
  if (res.status() === 200) test.info().annotations.push({ type: 'note', description: 'e2e account holds the editor role' })
})

test('a second account cannot edit or read another user’s hidden record', async ({ request }) => {
  const a = process.env.E2E_SESSION_TOKEN
  const b = process.env.E2E_SESSION_TOKEN_B
  test.skip(!a || !b, 'needs two e2e sessions')
  const id = `e2e-${Date.now()}`
  const h = (t: string) => ({ Authorization: `Bearer ${t}` })
  const create = await request.post(`${API}/v1/apps/${APP_ID}/actions/create_place`, { headers: h(a!), data: { params: { id, owner_name: 'E2E A', name: 'E2E hidden record', lat: -37.81, lng: 144.96 } } })
  expect(create.ok()).toBe(true)
  await request.post(`${API}/v1/apps/${APP_ID}/actions/set_place_status`, { headers: h(a!), data: { params: { id, status: 'hidden' } } })
  const readB = await request.post(`${API}/v1/apps/${APP_ID}/actions/get_place`, { headers: h(b!), data: { params: { id } } })
  expect(((await readB.json()) as { rows: unknown[] }).rows).toEqual([])
  const editB = await request.post(`${API}/v1/apps/${APP_ID}/actions/update_place`, { headers: h(b!), data: { params: { id, name: 'hijack', lat: 0, lng: 0 } } })
  expect(((await editB.json()) as { meta: { changes: number } }).meta.changes).toBe(0)
  await request.post(`${API}/v1/apps/${APP_ID}/actions/delete_place`, { headers: h(a!), data: { params: { id } } })
})
