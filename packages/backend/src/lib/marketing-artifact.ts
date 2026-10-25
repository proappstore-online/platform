/**
 * Marketing-site artifacts (#399): the manifest the storefront's Astro build
 * writes (`proappstore-online/proappstore` marketing/build.mjs →
 * `artifact-manifest.json`), and its verification against R2.
 *
 * An artifact lives at `marketing/<appId>/revisions/<revision>/` in pas-apps,
 * the prefix the host serves from (packages/host/src/marketing-site.ts). Every
 * key is built from the app id and revision of the URL, never from the
 * manifest, and only paths the host would serve are accepted.
 */

export const MARKETING_REVISION_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const MANIFEST_FILE = 'artifact-manifest.json';
const MAX_ARTIFACT_FILES = 200;
const MAX_ARTIFACT_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
/** The one file a site must have. robots.txt and sitemap.xml are optional (#408). */
const REQUIRED = ['/index.html'];

/**
 * The content type recorded for each extension a marketing build may contain.
 * The canonical deploy step writes the manifest with exactly this map
 * (packages/admin/src/publish.ts deployWorkflowYaml); the host serves the same
 * types (host.ts contentType).
 */
export const MARKETING_CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  woff2: 'font/woff2',
};
const TYPES = MARKETING_CONTENT_TYPES;

interface ArtifactFile {
  path: string;
  contentType: string;
  size: number;
  sha256: string;
}

export interface ArtifactManifest {
  schemaVersion: 1;
  appId: string;
  revision: string;
  preview: false;
  origin: string;
  files: ArtifactFile[];
}

export function marketingPrefix(appId: string, revision: string): string {
  return `marketing/${appId}/revisions/${revision}/`;
}

/**
 * Whether the host would serve this path — the same rule as host
 * marketing-site.ts `assetPath`, so nothing unservable (a source map, a
 * dotfile, the manifest itself) is ever uploaded. Every segment is a plain
 * name; HTML only as an `index.html`, so `/privacy/` resolves to
 * `/privacy/index.html` (Astro's directory output).
 */
export function servablePath(path: string): boolean {
  if (path.length > 200 || !path.startsWith('/')) return false;
  const parts = path.slice(1).split('/');
  if (!parts.every((part) => /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(part))) return false;
  const name = parts[parts.length - 1]!;
  if (/\.map$/i.test(name) || path === `/${MANIFEST_FILE}`) return false;
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  if (!TYPES[ext]) return false;
  return ext !== 'html' || name === 'index.html';
}

/** The validated manifest, or the first problem with it. */
export function parseArtifactManifest(text: string, appId: string, revision: string): ArtifactManifest | string {
  if (text.length > MAX_MANIFEST_BYTES) return 'manifest too large';
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return 'manifest is not JSON';
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'manifest is not an object';
  if (raw.schemaVersion !== 1) return 'unsupported manifest schemaVersion';
  if (raw.appId !== appId) return 'manifest appId does not match the app';
  if (raw.revision !== revision) return 'manifest revision does not match the revision';
  if (raw.preview !== false) return 'a preview build cannot be published';
  if (raw.origin !== `https://about-${appId}.proappstore.online`) return 'manifest origin is not the app marketing origin';
  if (!Array.isArray(raw.files) || raw.files.length === 0) return 'manifest lists no files';
  if (raw.files.length > MAX_ARTIFACT_FILES) return `at most ${MAX_ARTIFACT_FILES} files`;

  const files: ArtifactFile[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const f of raw.files as Record<string, unknown>[]) {
    const path = f?.path;
    if (typeof path !== 'string' || !servablePath(path)) return `not a publishable path: ${String(path).slice(0, 100)}`;
    if (seen.has(path)) return `duplicate path: ${path}`;
    seen.add(path);
    const ext = path.split('.').pop()!.toLowerCase();
    if (!TYPES[ext] || f.contentType !== TYPES[ext]) return `unexpected content type for ${path}`;
    if (typeof f.size !== 'number' || !Number.isInteger(f.size) || f.size < 0 || f.size > MAX_ARTIFACT_FILE_BYTES) return `invalid size for ${path}`;
    if (typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)) return `invalid sha256 for ${path}`;
    total += f.size;
    files.push({ path, contentType: TYPES[ext]!, size: f.size, sha256: f.sha256 });
  }
  if (total > MAX_ARTIFACT_BYTES) return 'artifact too large';
  for (const required of REQUIRED) if (!seen.has(required)) return `missing required file: ${required}`;
  return { schemaVersion: 1, appId, revision, preview: false, origin: raw.origin, files };
}

export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Re-read an uploaded artifact from R2 and check it is exactly what was
 * recorded: the manifest's own hash, then every listed file's size and hash.
 * Null when intact; otherwise what is wrong. Throws only when R2 does.
 */
export async function verifyStoredArtifact(
  bucket: R2Bucket,
  appId: string,
  revision: string,
  manifestSha256: string,
): Promise<string | null> {
  const prefix = marketingPrefix(appId, revision);
  const stored = await bucket.get(prefix + MANIFEST_FILE);
  if (!stored) return 'artifact manifest is missing';
  const manifestBytes = await stored.arrayBuffer();
  if ((await sha256Hex(manifestBytes)) !== manifestSha256) return 'artifact manifest was changed after upload';
  const manifest = parseArtifactManifest(new TextDecoder().decode(manifestBytes), appId, revision);
  if (typeof manifest === 'string') return manifest;
  for (const file of manifest.files) {
    const object = await bucket.get(prefix + file.path.slice(1));
    if (!object) return `artifact file is missing: ${file.path}`;
    const bytes = await object.arrayBuffer();
    if (bytes.byteLength !== file.size || (await sha256Hex(bytes)) !== file.sha256) return `artifact file does not match its manifest: ${file.path}`;
  }
  return null;
}
