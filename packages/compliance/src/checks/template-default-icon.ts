import { isTemplateDefaultIcon } from '../default-icons.js';
import type { FileSource } from '../lib/file-source.js';
import type { CheckResult } from '../types.js';

const ICONS = [
  { size: 192, path: 'web/public/icon-192.png' },
  { size: 512, path: 'web/public/icon-512.png' },
] as const;

/**
 * Warns while the app still serves an icon the app template shipped (the old "F", or the
 * "PAS" placeholder), so every app does not look the same in tabs, installs and listings (#505).
 * Warn, not fail: the app works; `pas brand icons --write` replaces them with the app's lettermark.
 * A missing or customised icon is never flagged.
 */
export async function checkTemplateDefaultIcon(source: FileSource): Promise<CheckResult> {
  const name = 'Template default icon';
  if (!source.readBytes) return { name, status: 'pass', detail: 'binary files not readable here; skipped' };
  const stale: string[] = [];
  for (const { size, path } of ICONS) {
    const bytes = await source.readBytes(path);
    if (bytes && isTemplateDefaultIcon(size, bytes)) stale.push(path);
  }
  if (stale.length === 0) return { name, status: 'pass', detail: 'no template-default icon served' };
  return {
    name,
    status: 'warn',
    detail: `still the template's icon: ${stale.join(', ')}`,
    suggestions: ['Run `pas brand icons` to preview, then `pas brand icons --write` to give the app its own lettermark. Custom icons are never overwritten.'],
  };
}
