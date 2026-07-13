import type { FileSource } from '../lib/file-source.js';
import { extractInlineManifest } from '../lib/inline-manifest.js';
import type { CheckResult } from '../types.js';

const STATIC_MANIFEST_PATH = 'web/public/manifest.json';
const VITE_CONFIG_PATH = 'web/vite.config.ts';

/**
 * Verifies the PWA manifest declares the four required fields (name,
 * short_name, start_url, display). Two valid sources, in order:
 *
 *   1. `web/public/manifest.json` — legacy static apps that ship their
 *      own manifest file.
 *   2. The `manifest: { ... }` block inside `VitePWA({...})` in
 *      `web/vite.config.ts` — the path every game currently uses.
 *
 * Either is fine; both being missing fails.
 */
export async function checkManifest(source: FileSource): Promise<CheckResult> {
  const staticRaw = await source.read(STATIC_MANIFEST_PATH);
  if (staticRaw !== null) {
    return validateStaticManifest(staticRaw);
  }

  const viteConfig = await source.read(VITE_CONFIG_PATH);
  if (viteConfig !== null && /\bVitePWA\s*\(/.test(viteConfig)) {
    return validateInlineManifest(viteConfig);
  }

  return {
    name: 'PWA manifest',
    status: 'fail',
    detail: `no manifest source found (looked for ${STATIC_MANIFEST_PATH} and a VitePWA(...) block in ${VITE_CONFIG_PATH})`,
    suggestions: [
      'Add a VitePWA(...) plugin to web/vite.config.ts with an inline manifest:{...} block, OR',
      'Add a static web/public/manifest.json with at least name, short_name, start_url, display, icons.',
    ],
  };
}

function validateStaticManifest(raw: string): CheckResult {
  let parsed: { name?: unknown; short_name?: unknown; start_url?: unknown; display?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      name: 'PWA manifest',
      status: 'fail',
      detail: `${STATIC_MANIFEST_PATH} is not valid JSON`,
    };
  }

  const required = ['name', 'short_name', 'start_url', 'display'] as const;
  const missing = required.filter((k) => typeof parsed[k] !== 'string' || parsed[k] === '');
  if (missing.length > 0) {
    // These four fields are REQUIRED for an installable PWA — a manifest that
    // exists but lacks them is broken, so fail (not warn) to block publish.
    return {
      name: 'PWA manifest',
      status: 'fail',
      detail: `missing required fields in ${STATIC_MANIFEST_PATH}: ${missing.join(', ')}`,
      suggestions: [`Add the ${missing.join(', ')} field(s) to manifest.json so installs work.`],
    };
  }
  return { name: 'PWA manifest', status: 'pass', detail: STATIC_MANIFEST_PATH };
}

function validateInlineManifest(viteConfig: string): CheckResult {
  const inline = extractInlineManifest(viteConfig);
  if (!inline) {
    return {
      name: 'PWA manifest',
      status: 'fail',
      detail: `VitePWA(...) call found in ${VITE_CONFIG_PATH} but the manifest:{...} block could not be parsed`,
      suggestions: [
        'Add a top-level `manifest: { name, short_name, start_url, display, icons, ... }` to your VitePWA() options.',
      ],
    };
  }

  const required: (keyof typeof inline)[] = ['name', 'short_name', 'start_url', 'display'];
  const missing = required.filter((k) => typeof inline[k] !== 'string' || inline[k] === '');
  if (missing.length > 0) {
    // Required-for-install fields — fail (not warn) to block publish.
    return {
      name: 'PWA manifest',
      status: 'fail',
      detail: `missing required fields in inline manifest (${VITE_CONFIG_PATH}): ${missing.join(', ')}`,
      suggestions: [`Add ${missing.join(', ')} to the manifest:{...} inside VitePWA({...}).`],
    };
  }
  return {
    name: 'PWA manifest',
    status: 'pass',
    detail: `inline in ${VITE_CONFIG_PATH} (name="${inline.name}", display="${inline.display}")`,
  };
}
