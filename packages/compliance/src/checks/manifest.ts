import type { FileSource } from '../lib/file-source.js';
import type { CheckResult } from '../types.js';

const MANIFEST_PATH = 'web/public/manifest.json';

/**
 * Verifies the PWA manifest exists at the expected location and parses
 * to JSON. Apps without a manifest can't be "Add to Home Screen"-d on
 * mobile; required by the platform.
 */
export async function checkManifest(source: FileSource): Promise<CheckResult> {
  const raw = await source.read(MANIFEST_PATH);
  if (raw === null) {
    return {
      name: 'PWA manifest',
      status: 'fail',
      detail: `${MANIFEST_PATH} missing`,
      suggestions: [
        'Add a manifest.json with at least name, short_name, start_url, display, icons.',
        'See template-standalone for a working example.',
      ],
    };
  }

  let parsed: { name?: unknown; short_name?: unknown; start_url?: unknown; display?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      name: 'PWA manifest',
      status: 'fail',
      detail: `${MANIFEST_PATH} is not valid JSON`,
    };
  }

  const required = ['name', 'short_name', 'start_url', 'display'] as const;
  const missing = required.filter((k) => typeof parsed[k] !== 'string' || parsed[k] === '');
  if (missing.length > 0) {
    return {
      name: 'PWA manifest',
      status: 'warn',
      detail: `missing fields: ${missing.join(', ')}`,
      suggestions: [`Add the ${missing.join(', ')} field(s) to manifest.json so installs work.`],
    };
  }
  return { name: 'PWA manifest', status: 'pass', detail: MANIFEST_PATH };
}
