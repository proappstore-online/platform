import type { FileSource } from '../lib/file-source.js';
import type { CheckResult } from '../types.js';

/**
 * The platform requires every published app/game to be MIT-licensed —
 * it's part of the "free forever, open source" promise on the
 * storefront. Looks for a top-level LICENSE file containing "MIT".
 *
 * Accepts LICENSE, LICENSE.md, LICENSE.txt — case-insensitive on the
 * basename. The MIT keyword check is intentionally loose: the canonical
 * MIT text starts with "MIT License" but variations exist.
 */
export async function checkLicenseMit(source: FileSource): Promise<CheckResult> {
  const candidates = [
    'LICENSE',
    'LICENSE.md',
    'LICENSE.txt',
    'license',
    'license.md',
    'license.txt',
  ];
  for (const path of candidates) {
    const content = await source.read(path);
    if (content === null) continue;
    if (/\bmit\b/i.test(content)) {
      return { name: 'MIT License', status: 'pass', detail: path };
    }
    return {
      name: 'MIT License',
      status: 'fail',
      detail: `${path} exists but does not mention MIT`,
      suggestions: [
        'Replace LICENSE with the standard MIT license text from https://opensource.org/license/mit',
      ],
    };
  }
  return {
    name: 'MIT License',
    status: 'fail',
    detail: 'no LICENSE file at repo root',
    suggestions: [
      'Add a LICENSE file with the MIT license text. The platform requires MIT for publication.',
      'Template: https://github.com/proappstore-online/template-standalone/blob/main/LICENSE',
    ],
  };
}
