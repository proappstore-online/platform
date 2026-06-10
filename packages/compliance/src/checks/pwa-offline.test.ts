import { describe, expect, it } from 'vitest';
import { mapFileSource } from '../lib/file-source.js';
import { checkPwaOffline } from './pwa-offline.js';

const VITE_CONFIG = 'web/vite.config.ts';
const INDEX_HTML = 'web/index.html';

// Mirror of bowling's known-good config — the reference everything else should look like.
const GOOD_WORKBOX = `
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
export default defineConfig({
  plugins: [
    VitePWA({
      workbox: {
        globPatterns: ["**/*.{js,css,html,png,svg,ico,woff2,wasm,json}"],
        maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
        navigateFallbackDenylist: [/^\\/\\.pas\\//],
        runtimeCaching: [
          { urlPattern: /^https:\\/\\/fonts\\.googleapis\\.com\\/.*/i, handler: "CacheFirst" },
          { urlPattern: /^https:\\/\\/fonts\\.gstatic\\.com\\/.*/i, handler: "CacheFirst" },
        ],
      },
    }),
  ],
});
`;

const HTML_WITH_FONTS = `<html><head>
  <link rel="manifest" href="/manifest.webmanifest" />
  <link href="https://fonts.googleapis.com/css2?family=Manrope" rel="stylesheet" />
</head></html>`;

const HTML_NO_FONTS = `<html><head>
  <link rel="manifest" href="/manifest.webmanifest" />
</head></html>`;

describe('checkPwaOffline', () => {
  it('fails when an app (has web/index.html) has no service worker (platform mandate)', async () => {
    // App with no PWA setup at all — no manifest link, no VitePWA, no
    // manual register. The mandate triggers on web/index.html presence
    // and demands a service worker.
    const r = await checkPwaOffline(
      mapFileSource(
        new Map([
          [VITE_CONFIG, 'export default { plugins: [] };'],
          [INDEX_HTML, '<html><head><title>x</title></head></html>'],
        ]),
      ),
    );
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/platform mandate/i);
  });

  it('fails when index.html exists but no vite.config.ts at all', async () => {
    // Still an app shape (it has a web entry); mandate still applies.
    const r = await checkPwaOffline(
      mapFileSource(new Map([[INDEX_HTML, '<html><head></head></html>']])),
    );
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/platform mandate/i);
  });

  it('passes when there is no web/index.html (not an app — admin/backend/etc.)', async () => {
    // No index.html → mandate exempt. The repo isn't shipping a web
    // entry, so it's not subject to the storefront PWA requirement.
    const r = await checkPwaOffline(
      mapFileSource(
        new Map([
          [VITE_CONFIG, 'export default { plugins: [] };'],
        ]),
      ),
    );
    expect(r.status).toBe('pass');
  });

  it('passes when an app has VitePWA configured (mandate satisfied)', async () => {
    const r = await checkPwaOffline(
      mapFileSource(
        new Map([
          [VITE_CONFIG, GOOD_WORKBOX],
          [INDEX_HTML, HTML_WITH_FONTS],
        ]),
      ),
    );
    expect(r.status).toBe('pass');
  });

  it('passes for a config that mirrors bowling', async () => {
    const r = await checkPwaOffline(
      mapFileSource(
        new Map([
          [VITE_CONFIG, GOOD_WORKBOX],
          [INDEX_HTML, HTML_WITH_FONTS],
        ]),
      ),
    );
    expect(r.status).toBe('pass');
  });

  it('passes when there is no vite config at all', async () => {
    const r = await checkPwaOffline(mapFileSource(new Map()));
    expect(r.status).toBe('pass');
    expect(r.detail).toMatch(/not a Vite/);
  });

  it('fails when index.html links a manifest but VitePWA is missing', async () => {
    const r = await checkPwaOffline(
      mapFileSource(
        new Map([
          [VITE_CONFIG, 'export default {};'],
          [INDEX_HTML, HTML_NO_FONTS],
        ]),
      ),
    );
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/no VitePWA|no service worker/i);
  });

  it('fails on a plain site that ships web/index.html with no SW (mandate)', async () => {
    // Post-mandate: shipping a web entry IS the install claim. There's
    // no opt-out for "plain site that happens to live on proappstore"
    // — every published app is mandated to be installable.
    const r = await checkPwaOffline(
      mapFileSource(
        new Map([
          [VITE_CONFIG, 'export default {};'],
          [INDEX_HTML, '<html><head><title>x</title></head></html>'],
        ]),
      ),
    );
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/platform mandate/i);
  });

  it('warns when maximumFileSizeToCacheInBytes is missing', async () => {
    const config = `
      import { VitePWA } from "vite-plugin-pwa";
      export default { plugins: [VitePWA({
        workbox: {
          globPatterns: ["**/*.{js,css,html,png,svg,ico,woff2,wasm,json}"],
          navigateFallbackDenylist: [/^\\/\\.pas\\//],
          runtimeCaching: [
            { urlPattern: /^https:\\/\\/fonts\\.googleapis\\.com\\/.*/i },
            { urlPattern: /^https:\\/\\/fonts\\.gstatic\\.com\\/.*/i },
          ],
        },
      })] };`;
    const r = await checkPwaOffline(
      mapFileSource(
        new Map([
          [VITE_CONFIG, config],
          [INDEX_HTML, HTML_WITH_FONTS],
        ]),
      ),
    );
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/maximumFileSizeToCacheInBytes/);
  });

  it('warns when Google Fonts are loaded but not in runtimeCaching', async () => {
    const config = `
      import { VitePWA } from "vite-plugin-pwa";
      export default { plugins: [VitePWA({
        workbox: {
          globPatterns: ["**/*.{js,css,html,png,svg,ico,woff2}"],
          maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
          navigateFallbackDenylist: [/^\\/\\.pas\\//],
        },
      })] };`;
    const r = await checkPwaOffline(
      mapFileSource(
        new Map([
          [VITE_CONFIG, config],
          [INDEX_HTML, HTML_WITH_FONTS],
        ]),
      ),
    );
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/Google Fonts/);
  });

  it('passes when Google Fonts not used and runtimeCaching omitted', async () => {
    const config = `
      import { VitePWA } from "vite-plugin-pwa";
      export default { plugins: [VitePWA({
        workbox: {
          globPatterns: ["**/*.{js,css,html,png,svg,ico,woff2}"],
          maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
          navigateFallbackDenylist: [/^\\/\\.pas\\//],
        },
      })] };`;
    const r = await checkPwaOffline(
      mapFileSource(
        new Map([
          [VITE_CONFIG, config],
          [INDEX_HTML, HTML_NO_FONTS],
        ]),
      ),
    );
    expect(r.status).toBe('pass');
  });

  it('fails when Workbox can intercept PAS reserved routes', async () => {
    const config = `
      import { VitePWA } from "vite-plugin-pwa";
      export default { plugins: [VitePWA({
        workbox: {
          globPatterns: ["**/*.{js,css,html,png,svg,ico,woff2}"],
          maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
        },
      })] };`;
    const r = await checkPwaOffline(
      mapFileSource(
        new Map([
          [VITE_CONFIG, config],
          [INDEX_HTML, HTML_NO_FONTS],
        ]),
      ),
    );
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/PAS reserved routes/i);
    expect(r.suggestions?.[0]).toContain('navigateFallbackDenylist');
  });

  it('fails when index.html links a manifest and there is no vite.config.ts at all (B1 regression)', async () => {
    // The bug this guards: an earlier version of the check short-circuited
    // to "pass — not a Vite project" when vite.config.ts was absent, which
    // missed broken PWAs whose entire build setup lives elsewhere or whose
    // PWA wiring was simply forgotten.
    const r = await checkPwaOffline(
      mapFileSource(
        new Map([
          [INDEX_HTML, HTML_NO_FONTS], // has manifest link
          // intentionally no vite.config.ts
        ]),
      ),
    );
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/no service worker/i);
  });

  it('passes when index.html links a manifest AND a manual service-worker registration is present (B2)', async () => {
    // Real-world: chess/puzzle hand-register `/sw.js` from an inline
    // script. The check should trust that as a legitimate alternative
    // to vite-plugin-pwa.
    const inlineRegister =
      '<html><head><link rel="manifest" href="/m.json" /></head><body>' +
      '<script>navigator.serviceWorker.register("/sw.js")</script></body></html>';
    const r = await checkPwaOffline(
      mapFileSource(new Map([[INDEX_HTML, inlineRegister]])),
    );
    expect(r.status).toBe('pass');
    expect(r.detail).toMatch(/hand-rolled service worker/i);
  });

  it('passes when manual SW registration lives in src/main.tsx (B2 src variant)', async () => {
    const r = await checkPwaOffline(
      mapFileSource(
        new Map([
          [INDEX_HTML, HTML_NO_FONTS], // has manifest link
          ['web/src/main.tsx', 'if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js");'],
        ]),
      ),
    );
    expect(r.status).toBe('pass');
  });

  it('warns when public/ has assets in extensions not in globPatterns (e.g. wasm)', async () => {
    const config = `
      import { VitePWA } from "vite-plugin-pwa";
      export default { plugins: [VitePWA({
        workbox: {
          globPatterns: ["**/*.{js,css,html,png,svg,ico,woff2}"],
          maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
          navigateFallbackDenylist: [/^\\/\\.pas\\//],
        },
      })] };`;
    const r = await checkPwaOffline(
      mapFileSource(
        new Map([
          [VITE_CONFIG, config],
          [INDEX_HTML, HTML_NO_FONTS],
          ['web/public/stockfish/stockfish.wasm', '\0\0'],
          ['web/public/stockfish/stockfish.js', '// engine'],
          ['web/public/icon-192.png', 'png-bytes'],
        ]),
      ),
    );
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/wasm/);
  });

  it('passes when VitePWA uses the injectManifest strategy (B3)', async () => {
    // With injectManifest, the developer writes their own SW file —
    // the `workbox` field doesn't apply, so we should not complain
    // about a missing workbox block.
    const config = `
      import { VitePWA } from "vite-plugin-pwa";
      export default { plugins: [VitePWA({
        strategies: "injectManifest",
        srcDir: "src",
        filename: "sw.ts",
      })] };`;
    const r = await checkPwaOffline(
      mapFileSource(
        new Map([
          [VITE_CONFIG, config],
          [INDEX_HTML, HTML_WITH_FONTS],
          ['web/src/sw.ts', '/* custom SW */'],
        ]),
      ),
    );
    expect(r.status).toBe('pass');
    expect(r.detail).toMatch(/injectManifest/);
  });

  it('handles globPatterns with multiple entries — extensions unioned across them (B4)', async () => {
    // First pattern omits wasm; second adds it. Should be treated as
    // covering wasm.
    const config = `
      import { VitePWA } from "vite-plugin-pwa";
      export default { plugins: [VitePWA({
        workbox: {
          globPatterns: ["**/*.{js,css,html,png,svg,ico,woff2}", "**/*.wasm"],
          maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
          navigateFallbackDenylist: [/^\\/\\.pas\\//],
          runtimeCaching: [
            { urlPattern: /^https:\\/\\/fonts\\.googleapis\\.com\\/.*/i },
            { urlPattern: /^https:\\/\\/fonts\\.gstatic\\.com\\/.*/i },
          ],
        },
      })] };`;
    const r = await checkPwaOffline(
      mapFileSource(
        new Map([
          [VITE_CONFIG, config],
          [INDEX_HTML, HTML_WITH_FONTS],
          ['web/public/engine.wasm', '\0'],
        ]),
      ),
    );
    expect(r.status).toBe('pass');
  });

  it('ignores VitePWA mentioned only in a comment (B5)', async () => {
    // The dev wrote `// VitePWA(...)` as a doc snippet but didn't
    // actually wire it. With an installable manifest link and no real
    // SW, this is the worst-case broken PWA — must fail.
    const config = `
      /* example usage:
         VitePWA({ workbox: { globPatterns: [...] } })
       */
      import react from "@vitejs/plugin-react";
      export default { plugins: [react()] };`;
    const r = await checkPwaOffline(
      mapFileSource(
        new Map([
          [VITE_CONFIG, config],
          [INDEX_HTML, HTML_WITH_FONTS],
        ]),
      ),
    );
    expect(r.status).toBe('fail');
  });

  it('does not be fooled into "claims install" by an HTML-commented <link rel="manifest"> (B7)', async () => {
    // The B7 fix is about HTML comments not satisfying the install
    // claim. Under the FAS mandate, the index.html itself is the
    // trigger (with or without an inline manifest link), so the
    // commented-out tag is moot here — but the assertion confirms the
    // mandate message is what fires, not the older "claims manifest
    // without SW" branch.
    const r = await checkPwaOffline(
      mapFileSource(
        new Map([
          [
            INDEX_HTML,
            '<html><head><!-- <link rel="manifest" href="/m.json"> --></head></html>',
          ],
        ]),
      ),
    );
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/platform mandate/i);
  });

  it('accepts request.destination filter as Google Fonts coverage (B8)', async () => {
    // A `({request}) => request.destination === "font"` rule catches
    // every font request including Google Fonts. Must not warn.
    const config = `
      import { VitePWA } from "vite-plugin-pwa";
      export default { plugins: [VitePWA({
        workbox: {
          globPatterns: ["**/*.{js,css,html,png,svg,ico,woff2,wasm,json}"],
          maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
          navigateFallbackDenylist: [/^\\/\\.pas\\//],
          runtimeCaching: [{
            urlPattern: ({ request }) => request.destination === "font",
            handler: "CacheFirst",
          }],
        },
      })] };`;
    const r = await checkPwaOffline(
      mapFileSource(
        new Map([
          [VITE_CONFIG, config],
          [INDEX_HTML, HTML_WITH_FONTS],
        ]),
      ),
    );
    expect(r.status).toBe('pass');
  });

  it('warns when maximumFileSizeToCacheInBytes is set below the workbox default (B10)', async () => {
    // Setting it to a value smaller than the 2 MB default is worse
    // than not setting it at all — small bundles still get dropped.
    const config = `
      import { VitePWA } from "vite-plugin-pwa";
      export default { plugins: [VitePWA({
        workbox: {
          globPatterns: ["**/*.{js,css,html,png,svg,ico,woff2,wasm,json}"],
          maximumFileSizeToCacheInBytes: 1024,
          navigateFallbackDenylist: [/^\\/\\.pas\\//],
        },
      })] };`;
    const r = await checkPwaOffline(
      mapFileSource(
        new Map([
          [VITE_CONFIG, config],
          [INDEX_HTML, HTML_NO_FONTS],
        ]),
      ),
    );
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/smaller than/i);
  });

  it('parses arithmetic in the bundle cap (e.g. 10 * 1024 * 1024)', async () => {
    const config = `
      import { VitePWA } from "vite-plugin-pwa";
      export default { plugins: [VitePWA({
        workbox: {
          globPatterns: ["**/*.{js,css,html,png,svg,ico,woff2,wasm,json}"],
          maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
          navigateFallbackDenylist: [/^\\/\\.pas\\//],
          runtimeCaching: [
            { urlPattern: /^https:\\/\\/fonts\\.googleapis\\.com\\/.*/i },
            { urlPattern: /^https:\\/\\/fonts\\.gstatic\\.com\\/.*/i },
          ],
        },
      })] };`;
    const r = await checkPwaOffline(
      mapFileSource(
        new Map([
          [VITE_CONFIG, config],
          [INDEX_HTML, HTML_WITH_FONTS],
        ]),
      ),
    );
    expect(r.status).toBe('pass');
  });

  it('warns when VitePWA is unconditionally disabled (B11)', async () => {
    const config = `
      import { VitePWA } from "vite-plugin-pwa";
      export default { plugins: [VitePWA({
        disable: true,
        workbox: {
          globPatterns: ["**/*.{js,css,html,png,svg,ico,woff2,wasm,json}"],
          maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
          navigateFallbackDenylist: [/^\\/\\.pas\\//],
        },
      })] };`;
    const r = await checkPwaOffline(
      mapFileSource(
        new Map([
          [VITE_CONFIG, config],
          [INDEX_HTML, HTML_NO_FONTS],
        ]),
      ),
    );
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/disable: true/i);
  });

  it('does not warn on conditional `disable: <expression>` (common dev-only pattern)', async () => {
    const config = `
      import { VitePWA } from "vite-plugin-pwa";
      export default { plugins: [VitePWA({
        disable: process.env.NODE_ENV !== "production",
        workbox: {
          globPatterns: ["**/*.{js,css,html,png,svg,ico,woff2,wasm,json}"],
          maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
          navigateFallbackDenylist: [/^\\/\\.pas\\//],
        },
      })] };`;
    const r = await checkPwaOffline(
      mapFileSource(
        new Map([
          [VITE_CONFIG, config],
          [INDEX_HTML, HTML_NO_FONTS],
        ]),
      ),
    );
    expect(r.status).toBe('pass');
  });

  it('handles globPatterns with glob bracket expressions [abc] (B9)', async () => {
    // The `[abc]` is inside the string literal — must not be mistaken
    // for the closing `]` of the globPatterns array.
    const config = `
      import { VitePWA } from "vite-plugin-pwa";
      export default { plugins: [VitePWA({
        workbox: {
          globPatterns: ["**/[abc]/*.{js,css,html,png,svg,ico,woff2}", "**/*.wasm"],
          maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
          navigateFallbackDenylist: [/^\\/\\.pas\\//],
        },
      })] };`;
    const r = await checkPwaOffline(
      mapFileSource(
        new Map([
          [VITE_CONFIG, config],
          [INDEX_HTML, HTML_NO_FONTS],
          ['web/public/engine.wasm', '\0'],
        ]),
      ),
    );
    expect(r.status).toBe('pass');
  });

  it('ignores "workbox: {" appearing inside a string literal (B6)', async () => {
    // A const help-text string mentioning the workbox shape should not
    // be picked up as the actual config block.
    const config = `
      import { VitePWA } from "vite-plugin-pwa";
      const help = "set workbox: { globPatterns: [...] } in your config";
      export default { plugins: [VitePWA({
        workbox: {
          globPatterns: ["**/*.{js,css,html,png,svg,ico,woff2,wasm,json}"],
          maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
          navigateFallbackDenylist: [/^\\/\\.pas\\//],
          runtimeCaching: [
            { urlPattern: /^https:\\/\\/fonts\\.googleapis\\.com\\/.*/i },
            { urlPattern: /^https:\\/\\/fonts\\.gstatic\\.com\\/.*/i },
          ],
        },
      })] };`;
    const r = await checkPwaOffline(
      mapFileSource(
        new Map([
          [VITE_CONFIG, config],
          [INDEX_HTML, HTML_WITH_FONTS],
        ]),
      ),
    );
    expect(r.status).toBe('pass');
  });
});
