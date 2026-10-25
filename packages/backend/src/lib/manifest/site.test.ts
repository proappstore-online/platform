import { describe, expect, it } from 'vitest';
import type { ToolManifest } from '../action-sql.js';
import { siteManifestFrom, validateSiteManifest } from './site.js';

const post = {
  name: 'get_post', description: 'One post', operation: 'query', requires_auth: false,
  sql: 'SELECT title, description, image_url FROM posts WHERE slug = :slug LIMIT 1',
  params: { slug: { type: 'string' } },
} as unknown as ToolManifest;
const feed = {
  name: 'sitemap_posts', description: 'Paths', operation: 'query', requires_auth: false,
  sql: 'SELECT path, updated_at FROM posts WHERE path > :cursor ORDER BY path LIMIT 100',
  params: { cursor: { type: 'string', optional: true } },
} as unknown as ToolManifest;

describe('siteManifestFrom', () => {
  it('keeps every site section and drops everything else', () => {
    const picked = siteManifestFrom({ page_meta: [], rooms: [], extra: 1 } as never);
    expect(picked.page_meta).toEqual([]);
    expect(picked.rooms).toEqual([]);
    expect(picked).not.toHaveProperty('extra');
    expect(Object.keys(siteManifestFrom(null))).toHaveLength(11);
  });
});

describe('validateSiteManifest', () => {
  it('accepts a page_meta route and a sitemap over public queries', () => {
    expect(validateSiteManifest([post, feed], { page_meta: [{ path: '/p/:slug', action: 'get_post', param: 'slug' }], sitemap: { action: 'sitemap_posts' } }))
      .toEqual({ routes: [{ path: '/p/:slug', action: 'get_post', param: 'slug' }], sitemap: 'sitemap_posts' });
  });

  it('accepts a manifest with neither section', () => {
    expect(validateSiteManifest([], {})).toEqual({ routes: [], sitemap: null });
  });

  it('refuses a malformed page_meta', () => {
    expect(validateSiteManifest([post], { page_meta: {} })).toEqual({ error: 'page_meta must be an array' });
    expect(validateSiteManifest([post], { page_meta: [{ path: 'p/:slug', action: 'get_post', param: 'slug' }] }))
      .toEqual({ error: 'page_meta[0]: path must start with / (max 200 chars)' });
    expect(validateSiteManifest([post], { page_meta: [{ path: '/p/:id', action: 'get_post', param: 'slug' }] }))
      .toEqual({ error: 'page_meta[0]: path must contain exactly one placeholder, :slug' });
  });

  it('refuses an action that is missing or not a public query', () => {
    expect(validateSiteManifest([post], { page_meta: [{ path: '/p/:slug', action: 'nope', param: 'slug' }] }))
      .toEqual({ error: 'page_meta[0]: action "nope" is not a tool in this manifest' });
    expect(validateSiteManifest([{ ...post, requires_auth: true } as ToolManifest], { page_meta: [{ path: '/p/:slug', action: 'get_post', param: 'slug' }] }))
      .toMatchObject({ error: expect.stringContaining('must be a public query') });
  });

  it('requires the page_meta action to select title, description and image_url', () => {
    const bare = { ...post, sql: 'SELECT title FROM posts WHERE slug = :slug LIMIT 1' } as ToolManifest;
    expect(validateSiteManifest([bare], { page_meta: [{ path: '/p/:slug', action: 'get_post', param: 'slug' }] }))
      .toEqual({ error: 'page_meta[0]: action "get_post" must select description, image_url' });
  });

  it('requires the sitemap action to declare a cursor and select path and updated_at', () => {
    expect(validateSiteManifest([post], { sitemap: { action: 'get_post' } }))
      .toMatchObject({ error: expect.stringContaining('must declare a cursor param') });
    expect(validateSiteManifest([{ ...feed, sql: 'SELECT path FROM posts WHERE path > :cursor LIMIT 5' } as ToolManifest], { sitemap: { action: 'sitemap_posts' } }))
      .toEqual({ error: 'sitemap: action "sitemap_posts" must select updated_at' });
  });
});
