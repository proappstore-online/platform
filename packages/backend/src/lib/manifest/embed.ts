/**
 * The `embed` section (#453): `{ "allow": ["https://example.com", "https://*.partner.com"] }`.
 *
 * Off by default. A hosted app's CSP `frame-ancestors` lists only itself and PAS's own
 * surfaces; letting another site frame the app exposes its signed-in users to clickjacking
 * (a transparent overlay over a real button). A creator who wants an embeddable widget or
 * booking form opts in here, naming the origins, and the host appends exactly those to
 * `frame-ancestors` for that app only.
 *
 * Origins are written into a response header, so the grammar is strict and closed: `https`,
 * an ASCII host with at least two labels, an optional port, nothing else. No path, query,
 * credentials, scheme other than https, IP address or bare `*`. One wildcard is allowed, as
 * the leading label (`https://*.example.com`), and never on a public suffix, a shared-hosting
 * domain or the platform's own zone: those would let any stranger's page frame the app.
 */

export const MAX_EMBED_ORIGINS = 10;
export interface EmbedConfig { allow: string[] }

/** `*.` wildcards on these would admit unrelated tenants of the suffix. Not exhaustive; a creator who needs one names the origin. */
const NO_WILDCARD_UNDER = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'edu.au', 'co.nz', 'co.jp', 'co.za', 'co.in', 'co.kr', 'com.br', 'com.cn', 'com.mx', 'com.sg', 'com.tr',
  'github.io', 'gitlab.io', 'pages.dev', 'workers.dev', 'vercel.app', 'netlify.app', 'herokuapp.com', 'web.app', 'firebaseapp.com', 'azurewebsites.net',
  'blogspot.com', 'wordpress.com', 'notion.site', 'framer.app', 'webflow.io', 'wixsite.com', 'squarespace.com', 'glitch.me', 'repl.co', 'onrender.com', 'fly.dev',
]);
/** The platform's own zone: a wildcard here would let any published app frame any other (the cross-app clickjacking #436 removed). */
const PLATFORM_ZONE = 'proappstore.online';

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** One origin, normalised (lowercase), or why it is refused. Pure. */
export function normaliseEmbedOrigin(raw: unknown): { origin: string } | { error: string } {
  if (typeof raw !== 'string') return { error: 'must be a string' };
  const s = raw.trim();
  if (s.length === 0 || s.length > 253) return { error: 'must be an origin of at most 253 characters' };
  const m = /^https:\/\/([^/?#@\s]+)$/i.exec(s);
  if (!m) return { error: 'must be an https origin like https://example.com (no path, query, credentials or other scheme)' };
  const lower = m[1]!.toLowerCase();
  const portMatch = /^(.*?)(?::(\d{1,5}))?$/.exec(lower)!;
  const host = portMatch[1]!;
  const port = portMatch[2];
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) return { error: 'has an invalid port' };

  const wildcard = host.startsWith('*.');
  const labels = (wildcard ? host.slice(2) : host).split('.');
  if (labels.length < 2 || labels.some((l) => !LABEL.test(l))) {
    return { error: wildcard ? 'a wildcard must be exactly one leading "*." followed by a domain of at least two labels' : 'must be a hostname of at least two labels (letters, digits and hyphens; punycode for non-ASCII)' };
  }
  if (/^\d+$/.test(labels[labels.length - 1]!)) return { error: 'must be a hostname, not an IP address' };
  if (wildcard) {
    const domain = labels.join('.');
    if (domain === PLATFORM_ZONE || domain.endsWith(`.${PLATFORM_ZONE}`)) return { error: `a wildcard on ${PLATFORM_ZONE} would let any published app frame yours; name the app origin instead` };
    for (let i = 0; i < labels.length; i++) {
      if (NO_WILDCARD_UNDER.has(labels.slice(i).join('.')) && i === 0) return { error: `a wildcard on ${domain} would admit unrelated sites; name the origin instead` };
    }
  }
  return { origin: `https://${host}${port === undefined ? '' : `:${port}`}` };
}

/**
 * Validate `embed`. Absent, null or `{ allow: [] }` is "no embedding" (`embed: null`), the
 * default. At most {@link MAX_EMBED_ORIGINS} distinct origins.
 */
export function validateEmbed(raw: unknown): { error: string } | { embed: EmbedConfig | null } {
  if (raw === undefined || raw === null) return { embed: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'embed must be an object like { "allow": ["https://example.com"] }' };
  const unknown = Object.keys(raw).find((k) => k !== 'allow');
  if (unknown) return { error: `embed: unknown field "${unknown}"` };
  const allow = (raw as { allow?: unknown }).allow;
  if (allow === undefined) return { error: 'embed.allow is required: a list of the https origins that may frame this app' };
  if (!Array.isArray(allow)) return { error: 'embed.allow must be an array of https origins' };
  if (allow.length > MAX_EMBED_ORIGINS) return { error: `embed.allow: at most ${MAX_EMBED_ORIGINS} origins` };
  const origins: string[] = [];
  for (const [i, item] of allow.entries()) {
    const r = normaliseEmbedOrigin(item);
    if ('error' in r) return { error: `embed.allow[${i}] ${r.error}` };
    if (origins.includes(r.origin)) return { error: `embed.allow[${i}]: duplicate origin ${r.origin}` };
    origins.push(r.origin);
  }
  return { embed: origins.length ? { allow: origins } : null };
}
