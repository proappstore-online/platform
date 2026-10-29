import { SELF, env as providedEnv } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../backend/src/types';
import { BASE, resetTables, seedApp, seedUser } from './helpers';

// #497 on real D1: GET /v1/storefront/apps names an app's about- marketing site only while the
// deploy pipeline (#408) has one active, so the storefront stops hand-keeping `websiteUrl`.

const env = providedEnv as unknown as Env;
const REV = '1111111111111111111111111111111111111111';

async function marketing(app: string, opts: { active?: string | null; receipt?: 'uploaded' | 'uploading' | 'failed' | null; receiptRevision?: string } = {}): Promise<void> {
  const { active = REV, receipt = 'uploaded', receiptRevision = active ?? REV } = opts;
  if (receipt) {
    await env.DB.prepare(
      "INSERT INTO app_marketing_deploys (app_id, revision, status, manifest_sha256, file_count, total_bytes, repository, created_at, updated_at) VALUES (?, ?, ?, 'x', 1, 1, 'proappstore-online/x', 1, 1)",
    ).bind(app, receiptRevision, receipt).run();
  }
  await env.DB.prepare('INSERT INTO app_marketing_sites (app_id, active_revision, updated_at) VALUES (?, ?, 1)').bind(app, active).run();
}

async function websiteUrls(): Promise<Record<string, string | null>> {
  const res = await SELF.fetch(`${BASE}/v1/storefront/apps`);
  expect(res.status).toBe(200);
  const { apps } = (await res.json()) as { apps: Array<{ appId: string; websiteUrl: string | null }> };
  return Object.fromEntries(apps.map((a) => [a.appId, a.websiteUrl]));
}

beforeEach(async () => {
  await resetTables();
  for (const t of ['app_marketing_sites', 'app_marketing_deploys', 'app_visibility', 'app_listings']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await seedUser('gh:1');
  for (const id of ['live', 'bare', 'rolledback', 'half', 'failed', 'stale', 'odd', 'secret']) await seedApp(id, 'gh:1');
});

describe('storefront inventory carries the about- site (#497)', () => {
  it('names the about-<id> URL for an app with an active, fully uploaded revision, and null for every other app', async () => {
    await marketing('live');
    const urls = await websiteUrls();
    expect(urls.live).toBe('https://about-live.proappstore.online');
    expect(urls.bare).toBeNull();
  });

  it('drops the URL when the site is unpublished or rolled back to nothing (active_revision NULL)', async () => {
    await marketing('rolledback');
    expect((await websiteUrls()).rolledback).toBe('https://about-rolledback.proappstore.online');
    await env.DB.prepare('UPDATE app_marketing_sites SET active_revision = NULL WHERE app_id = ?').bind('rolledback').run();
    expect((await websiteUrls()).rolledback).toBeNull();
  });

  it('does not name a site whose active revision was never fully uploaded (uploading or failed)', async () => {
    await marketing('half', { receipt: 'uploading' });
    await marketing('failed', { receipt: 'failed' });
    const urls = await websiteUrls();
    expect(urls.half).toBeNull();
    expect(urls.failed).toBeNull();
  });

  it('does not name a site whose active pointer has no receipt, or a receipt for a different revision', async () => {
    await marketing('stale', { receipt: 'uploaded', receiptRevision: '2222222222222222222222222222222222222222' });
    expect((await websiteUrls()).stale).toBeNull();
  });

  it('does not name a revision the host would refuse to serve', async () => {
    await marketing('odd', { active: '../etc/passwd' });
    expect((await websiteUrls()).odd).toBeNull();
  });

  it('keeps a private app out of the inventory altogether, marketing site or not', async () => {
    await marketing('secret');
    await env.DB.prepare("INSERT INTO app_visibility (app_id, mode, created_at) VALUES ('secret', 'private', 1)").run();
    expect(Object.keys(await websiteUrls())).not.toContain('secret');
  });

  it('is not the owner-typed listing website: a typed one never appears here, and an app with a site and no listing still gets its URL', async () => {
    await marketing('live');
    await env.DB.prepare("INSERT INTO app_listings (app_id, website_url, updated_at) VALUES ('bare', 'https://example.com', 1)").run();
    const urls = await websiteUrls();
    expect(urls.bare).toBeNull();
    expect(urls.live).toBe('https://about-live.proappstore.online');
  });
});

// #504: registry.json (proappstore) hand-types `about` as a duplicate of this same listing
// copy. Carrying longDescription in the bulk inventory lets a catalogue generator read it
// from here instead — the same move #497 made for websiteUrl.
describe('storefront inventory carries the moderated long description (#504)', () => {
  async function longDescriptions(): Promise<Record<string, string | null>> {
    const res = await SELF.fetch(`${BASE}/v1/storefront/apps`);
    expect(res.status).toBe(200);
    const { apps } = (await res.json()) as { apps: Array<{ appId: string; longDescription: string | null }> };
    return Object.fromEntries(apps.map((a) => [a.appId, a.longDescription]));
  }

  it('carries the owner-written long description for an app with a listing, and null without one', async () => {
    await env.DB.prepare("INSERT INTO app_listings (app_id, long_description, updated_at) VALUES ('live', 'Longer story about live.', 1)").run();
    const descriptions = await longDescriptions();
    expect(descriptions.live).toBe('Longer story about live.');
    expect(descriptions.bare).toBeNull();
  });
});
