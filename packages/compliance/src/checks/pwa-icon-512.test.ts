import { describe, expect, it } from 'vitest';
import { mapFileSource } from '../lib/file-source.js';
import { checkPwaIcon512, listingIconSize } from './pwa-icon-512.js';

const vite = (icons: string) => `
import { VitePWA } from "vite-plugin-pwa";
export default {
  plugins: [
    VitePWA({
      manifest: {
        name: 'X', short_name: 'X', start_url: '/', display: 'standalone',
        icons: [
${icons}
        ],
      },
    }),
  ],
};
`;
const ICON_192 = "          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },";
const ICON_512 = "          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },";
const PNG = '\x89PNG';

const run = (files: Record<string, string>) => checkPwaIcon512(mapFileSource(new Map(Object.entries(files))));

describe('checkPwaIcon512 (#630)', () => {
  it("passes for an inline 512x512 'any maskable' icon whose file exists", async () => {
    const r = await run({ 'web/vite.config.ts': vite(`${ICON_192}\n${ICON_512}`), 'web/public/icon-192.png': PNG, 'web/public/icon-512.png': PNG });
    expect(r.status).toBe('pass');
    expect(r.detail).toContain('web/public/icon-512.png');
  });

  it('warns when the largest icon is 192 px', async () => {
    const r = await run({ 'web/vite.config.ts': vite(ICON_192), 'web/public/icon-192.png': PNG });
    expect(r.status).toBe('warn');
    expect(r.suggestions?.[0]).toContain('pas brand icons --write');
  });

  it("warns when the 512 px icon is purpose 'maskable' only", async () => {
    const icons = "          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },";
    const r = await run({ 'web/vite.config.ts': vite(icons), 'web/public/icon-512.png': PNG });
    expect(r.status).toBe('warn');
  });

  it('warns for a static manifest with icons: [] (meetup)', async () => {
    const r = await run({ 'web/public/manifest.json': JSON.stringify({ name: 'X', icons: [] }) });
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('web/public/manifest.json');
  });

  it('warns when the declared /icon-512.png is not in web/public (prolang)', async () => {
    const manifest = JSON.stringify({ name: 'X', icons: [{ src: '/icon-512.png?v=2', sizes: '512x512', type: 'image/png' }] });
    const r = await run({ 'web/public/manifest.json': manifest, 'web/public/icon-192.png': PNG });
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('declared but missing: web/public/icon-512.png');
  });

  it("does not call an icon missing where the source holds no images, as the publish gate's text-only fetch does", async () => {
    // provision.ts feeds fetchRepoFiles, which fetches manifest.json but never a PNG: a real
    // icon must not read as missing there, or every publish carries a false warning.
    const manifest = JSON.stringify({ name: 'X', icons: [{ src: '/icon-512.png', sizes: '512x512', type: 'image/png' }] });
    const r = await run({ 'web/public/manifest.json': manifest });
    expect(r.status).toBe('pass');
    expect(r.detail).toContain('not checked');
  });

  it('passes when there is no manifest source (reported by the PWA manifest check)', async () => {
    const r = await run({});
    expect(r.status).toBe('pass');
  });

  it('qualifies only square sizes of at least 512 with purpose absent or including any', () => {
    expect(listingIconSize({ sizes: '512x512' })).toBe(512);
    expect(listingIconSize({ sizes: '192x192 1024x1024', purpose: 'any' })).toBe(1024);
    expect(listingIconSize({ sizes: '512x256', purpose: 'any' })).toBe(0);
    expect(listingIconSize({ sizes: '512x512', purpose: 'monochrome' })).toBe(0);
    expect(listingIconSize({ sizes: 'any' })).toBe(0);
  });
});
