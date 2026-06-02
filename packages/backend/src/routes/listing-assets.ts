export const ALLOWED_KINDS = new Set(['icon', 'privacy-policy', 'terms']);
export const SCREENSHOT_KIND = /^screenshot-[0-7]$/;

export const MAX_ICON = 5 * 1024 * 1024;
export const MAX_SCREENSHOT = 8 * 1024 * 1024;
export const MAX_MD = 200 * 1024;

export const IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/svg+xml',
]);

export function extFor(contentType: string): string | null {
  return {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'text/markdown': 'md',
    'text/plain': 'md',
  }[contentType.toLowerCase()] ?? null;
}
