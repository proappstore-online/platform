/** Store-listing generator: its model and the sanitiser for its untrusted output. */

/** The listing generator's model (priced in runtimes/pricing.ts). */
export const LISTING_MODEL = 'claude-haiku-4-5';

/** Store-listing categories (must match the storefront allow-list). */
const LISTING_CATEGORIES = [
  'productivity', 'social', 'marketplace', 'transport', 'finance',
  'health', 'education', 'entertainment', 'tools', 'other',
] as const;

/**
 * Coerce untrusted model output (#91) into a safe listing: only the known
 * fields, category validated against the allow-list (else 'other'), lengths
 * clamped. Prevents prompt-injected repo content from poisoning the public card.
 */
export function sanitizeListing(raw: unknown): { tagline: string; longDescription: string; category: string } {
  const l = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v : '').slice(0, max);
  const category = typeof l.category === 'string' && (LISTING_CATEGORIES as readonly string[]).includes(l.category)
    ? l.category
    : 'other';
  return { tagline: str(l.tagline, 120), longDescription: str(l.longDescription, 4000), category };
}
