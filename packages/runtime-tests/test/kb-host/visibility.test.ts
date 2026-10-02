import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

beforeAll(async () => {
  await env.DB.exec("CREATE TABLE app_visibility (app_id TEXT PRIMARY KEY, mode TEXT); INSERT INTO app_visibility VALUES ('private-app', 'private'), ('public-app', 'public');");
  for (const app of ['private-app', 'public-app', 'undeclared', 'platform']) {
    await env.KB_R2.put(`${app}/index.html`, `${app} page`);
    await env.KB_R2.put(`${app}/assets/style.css`, 'secret style');
    await env.KB_R2.put(`${app}/404.html`, `${app} custom error`);
    await env.KB_R2.put(`${app}/.e2e/summary.json`, '{"passed":3}');
  }
});
const read = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
  SELF.fetch(`https://kb.proappstore.online/${path}`, { headers, method });

describe('KB visibility (#277)', () => {
  it('refuses every private path and HEAD before reading pages or custom errors', async () => {
    for (const path of ['private-app/', 'private-app/assets/style.css', 'private-app/missing/', 'private-app/.e2e/summary.json', '%70rivate-app/']) {
      for (const method of ['GET', 'HEAD']) {
        const res = await read(path, {}, method);
        expect(res.status).toBe(404);
        expect(res.headers.get('cache-control')).toBe('private, no-store');
        expect(await res.text()).not.toContain('private-app');
      }
    }
    expect((await read('private-app/', { 'x-internal-token': 'wrong' })).status).toBe(404);
  });

  it('serves public and undeclared apps and platform docs', async () => {
    for (const app of ['public-app', 'undeclared', 'platform']) {
      const res = await read(`${app}/`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(`${app} page`);
    }
    const docs = await SELF.fetch('https://docs.proappstore.online/');
    expect(await docs.text()).toBe('platform page');
  });

  it('preserves internal test-result harvests without publicly caching private content', async () => {
    const headers = { 'x-internal-token': env.INTERNAL_TOKEN };
    const res = await read('private-app/.e2e/summary.json', headers);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ passed: 3 });
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const etag = res.headers.get('etag')!;
    expect((await read('private-app/.e2e/summary.json', { 'if-none-match': etag })).status).toBe(404);
    const unchanged = await read('private-app/.e2e/summary.json', { ...headers, 'if-none-match': etag });
    expect(unchanged.status).toBe(304);
    expect(unchanged.headers.get('cache-control')).toBe('private, no-store');
    const missing = await read('private-app/missing/', headers);
    expect(await missing.text()).toBe('private-app custom error');
    expect(missing.headers.get('cache-control')).toBe('private, no-store');
  });

  it('checks visibility again after a public-to-private flip', async () => {
    const publicPage = await read('public-app/');
    expect(publicPage.status).toBe(200);
    await publicPage.text();
    await env.DB.prepare("UPDATE app_visibility SET mode = 'private' WHERE app_id = 'public-app'").run();
    expect((await read('public-app/')).status).toBe(404);
  });

  it('fails closed when visibility cannot be read', async () => {
    await env.DB.exec('DROP TABLE app_visibility');
    const res = await read('private-app/');
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
