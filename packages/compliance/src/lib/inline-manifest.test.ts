import { describe, expect, it } from 'vitest';
import { extractInlineManifest } from './inline-manifest.js';

// #430: the manifest object and its icons array are found by one quote-aware
// bracket matcher; these pin what it must ignore.
describe('extractInlineManifest', () => {
  const config = (manifest: string) => `import { VitePWA } from 'vite-plugin-pwa';
export default { plugins: [VitePWA({ registerType: 'autoUpdate', manifest: ${manifest} })] };`;

  it('reads the fields, ignoring braces and brackets inside quoted values', () => {
    const m = extractInlineManifest(config(`{
      name: 'Shop {beta}',
      short_name: "Shop ]",
      start_url: \`/\`,
      display: 'standalone',
      min_viewport_width: 360,
      icons: [{ src: '/a].png', sizes: '192x192' }, { src: "/b}.png", purpose: 'maskable' }],
    }`));
    expect(m).toMatchObject({ name: 'Shop {beta}', start_url: '/', display: 'standalone', min_viewport_width: 360, icons: true });
    expect(m!.iconsRaw).toBe(`[{ src: '/a].png', sizes: '192x192' }, { src: "/b}.png", purpose: 'maskable' }]`);
  });

  it('an escaped quote does not end a string', () => {
    const m = extractInlineManifest(config(`{ name: 'It\\'s }', icons: [{ src: 'x\\']' }] }`));
    expect(m!.iconsRaw).toBe(`[{ src: 'x\\']' }]`);
  });

  it('an unbalanced manifest or icons array is not found', () => {
    expect(extractInlineManifest("VitePWA({ manifest: { name: 'x', icons: [")).toBeNull();
    expect(extractInlineManifest(config(`{ name: 'x', icons: [{ src: 'a' }`))!.iconsRaw).toBeUndefined();
  });
});
