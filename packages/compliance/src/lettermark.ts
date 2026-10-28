/**
 * The app lettermark (#433, #505): the one or two initials every PAS surface shows
 * for an app that has not set its own branding. Pure (no node imports) so the CLI,
 * the admin Worker and the Agent Teams seed all derive the same letters from a name.
 */

const STOP_WORDS = new Set(['a', 'an', 'and', 'for', 'in', 'of', 'on', 'the', 'to']);

/**
 * Deterministic lettermark: one letter for a single word, the first two
 * initials for several (Hiring -> H, DoorDrop / Door Drop / door-drop -> DD).
 */
export function deriveLettermark(appName: string): string {
  const ascii = appName.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const words = ascii
    .replace(/['’]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const meaningful = words.filter((w) => !STOP_WORDS.has(w.toLowerCase()));
  const picked = meaningful.length > 0 ? meaningful : words;
  if (picked.length === 0) return 'A';
  return picked
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
}

/** Accessible name for the icon: the full app name, never just the initials. */
export function lettermarkLabel(appName: string): string {
  return `${appName.trim() || 'App'} app icon`;
}
