/**
 * Adding template-app's Astro marketing site (#407) to an existing app repo:
 * the part shared by `pas marketing add` (#410) and the MCP `add_marketing_site`
 * tool (#421). The CLI is published to npm and cannot depend on this private
 * package, so it keeps its own copy of `prefillSite`; marketing-site.test.ts
 * holds the two to the same output.
 */

/** The public listing fields the site is pre-filled from (GET /v1/storefront/apps/:id). */
export interface MarketingListing {
  tagline?: string | null;
  longDescription?: string | null;
  themeColor?: string | null;
  supportUrl?: string | null;
}

/** Root package.json scripts added where absent. marketing/ stays outside the pnpm workspace. */
export const MARKETING_SCRIPTS: Readonly<Record<string, string>> = {
  'dev:marketing': 'pnpm --dir marketing --ignore-workspace dev',
  'build:marketing': 'pnpm --dir marketing --ignore-workspace build',
};

/** Template files that are text: APPNAME is replaced in these; anything else is copied byte for byte. */
export const MARKETING_TEXT_EXTENSIONS: ReadonlySet<string> = new Set(['.ts', '.astro', '.json', '.css', '.md', '.mjs', '.js', '.html', '.txt', '.xml', '.svg']);

/** The canonical deploy step that builds and publishes marketing/ (#408); its absence means a push will not publish. */
export const MARKETING_DEPLOY_STEP = 'Publish marketing site';

/**
 * Whether an app's `.github/workflows/deploy.yml` publishes marketing/ on push:
 * a copied workflow that carries the step, or (#427) a caller of the platform's
 * reusable pipeline that does not switch it off with `marketing: false`.
 */
export function deployPublishesMarketing(deployYaml: string): boolean {
  if (deployYaml.includes(MARKETING_DEPLOY_STEP)) return true;
  return /uses:\s*proappstore-online\/platform\/\.github\/workflows\/app-deploy\.yml@/.test(deployYaml)
    && !/^\s*marketing:\s*['"]?false['"]?\s*(#.*)?$/m.test(deployYaml);
}

function hex(v: unknown): string | null {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : null;
}

/** Mix a #rrggbb colour toward `target` (0 = unchanged, 1 = target). */
function mix(color: string, target: number, amount: number): string {
  const c = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  return '#' + c.map((v) => Math.round(v + (target - v) * amount).toString(16).padStart(2, '0')).join('');
}

/** Replace `key: <literal>` in site.ts; returns whether it matched. */
function setField(src: { text: string }, key: string, value: string): boolean {
  const re = new RegExp(`(\\n\\s*${key}: )(?:'[^'\\n]*'|"[^"\\n]*")`);
  if (!re.test(src.text)) return false;
  src.text = src.text.replace(re, `$1${JSON.stringify(value)}`);
  return true;
}

/** An app id as a display name: `my-app` → `My App` (as the CLI's toTitleCase). */
function titleCase(id: string): string {
  return id.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** site.ts with the app's name and, when the public listing has them, its tagline, support link and brand colour. */
export function prefillSite(text: string, appId: string, listing: MarketingListing | null): { text: string; prefilled: string[] } {
  const name = titleCase(appId);
  const src = { text };
  const prefilled: string[] = [];
  if (setField(src, 'name', name)) prefilled.push('name');
  if (setField(src, 'headline', `Explore ${name}.`)) prefilled.push('headline');
  if (setField(src, 'ctaLabel', `Open ${name}`)) prefilled.push('ctaLabel');
  if (setField(src, 'owner', `The ${name} team`)) prefilled.push('owner');
  const summary = (listing?.tagline || listing?.longDescription || '').trim().slice(0, 300);
  if (summary && setField(src, 'summary', summary)) prefilled.push('summary');
  const support = typeof listing?.supportUrl === 'string' && /^https:\/\//.test(listing.supportUrl) ? listing.supportUrl : null;
  if (support && setField(src, 'supportUrl', support)) prefilled.push('supportUrl');
  const accent = hex(listing?.themeColor);
  if (accent) {
    const ok = setField(src, 'accent', accent)
      && setField(src, 'accentDeep', mix(accent, 0, 0.35))
      && setField(src, 'accentSoft', mix(accent, 255, 0.7));
    if (ok) prefilled.push('colors');
  }
  return { text: src.text, prefilled };
}
