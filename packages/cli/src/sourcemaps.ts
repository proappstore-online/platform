import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join, sep } from 'node:path';
import { Command } from 'commander';

/**
 * `pas sourcemaps upload` (#393, ADR-008 decision 7): send a build's hidden
 * source maps to the platform's PRIVATE store as one release bundle, then remove
 * them from the build so the public upload never carries them.
 *
 * Keyless, like every deploy step: in GitHub Actions it mints the repository's
 * OIDC token itself; `PAS_OIDC_TOKEN` may carry one minted elsewhere. No stored
 * secret, and no session token — the platform accepts only the app repository's
 * OIDC on main, for the commit the run is building.
 *
 * Bundle: `{ "files": { "<asset path>": <v3 source map> } }`, the asset path being
 * the map's path in the build without `.map` (`assets/index-abc.js`). Limits match
 * the platform's: 500 maps, 20 MB in total.
 */

const API_BASE = 'https://api.proappstore.online';
const MAX_FILES = 500;
export const MAX_BUNDLE_BYTES = 20 * 1024 * 1024;
const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;

/** Every `*.map` under `dir`, as build-relative POSIX paths, sorted. */
export function findSourceMaps(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .map(String)
    .filter((f) => f.endsWith('.map') && statSync(join(dir, f)).isFile())
    .map((f) => f.split(sep).join('/'))
    .sort();
}

/** The release bundle for `dir`'s maps, refused (throws) when over the platform's limits or not JSON. */
export function buildBundle(dir: string, maps: string[] = findSourceMaps(dir)): { body: Buffer; count: number; digest: string } {
  if (maps.length === 0) throw new Error(`no *.map files in ${dir} — build with source maps (vite: build.sourcemap: 'hidden')`);
  if (maps.length > MAX_FILES) throw new Error(`${maps.length} source maps — the platform takes at most ${MAX_FILES} per release`);
  let total = 0;
  const files: Record<string, unknown> = {};
  for (const rel of maps) {
    const raw = readFileSync(join(dir, rel));
    total += raw.length;
    if (total > MAX_BUNDLE_BYTES) throw new Error(`source maps exceed ${MAX_BUNDLE_BYTES / 1024 / 1024} MB in total — refusing to upload`);
    try {
      files[rel.slice(0, -'.map'.length)] = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new Error(`${rel} is not a JSON source map`);
    }
  }
  const body = Buffer.from(JSON.stringify({ files }));
  if (body.length > MAX_BUNDLE_BYTES) throw new Error(`source-map bundle exceeds ${MAX_BUNDLE_BYTES / 1024 / 1024} MB — refusing to upload`);
  return { body, count: maps.length, digest: createHash('sha256').update(body).digest('hex') };
}

/** Delete `dir`'s maps so the public upload cannot carry them. Returns how many. */
export function stripSourceMaps(dir: string, maps: string[] = findSourceMaps(dir)): number {
  for (const rel of maps) unlinkSync(join(dir, rel));
  return maps.length;
}

/** The GitHub OIDC token for the platform audience: `PAS_OIDC_TOKEN`, or minted from the Actions runtime. */
export async function oidcToken(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<string> {
  if (env.PAS_OIDC_TOKEN) return env.PAS_OIDC_TOKEN;
  const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !bearer) {
    throw new Error('no OIDC token: run in GitHub Actions with `permissions: id-token: write` (keyless; no stored secret is accepted)');
  }
  const res = await fetchImpl(`${url}&audience=${encodeURIComponent(API_BASE)}`, { headers: { Authorization: `bearer ${bearer}` } });
  const value = res.ok ? ((await res.json()) as { value?: string }).value : undefined;
  if (!value) throw new Error(`could not obtain an OIDC token (HTTP ${res.status})`);
  return value;
}

export type UploadOutcome =
  | { status: 'uploaded'; count: number; digest: string; expiresAt: number }
  | { status: 'exists'; count: number; digest: string };

/**
 * Upload the bundle for `commitSha` and verify the platform recorded exactly the
 * bytes sent (its digest equals ours). A 409 means this commit's release already
 * exists — immutable, so a re-run is not an error. Anything else throws.
 */
export async function uploadSourceMaps(opts: {
  dir: string;
  appId: string;
  commitSha: string;
  token: string;
  apiBase?: string | undefined;
  fetchImpl?: typeof fetch;
}): Promise<UploadOutcome> {
  const commitSha = opts.commitSha.toLowerCase();
  if (!COMMIT_SHA_RE.test(commitSha)) throw new Error('--commit must be a 40-character commit SHA');
  const { body, count, digest } = buildBundle(opts.dir);
  const res = await (opts.fetchImpl ?? fetch)(`${opts.apiBase ?? API_BASE}/v1/apps/${encodeURIComponent(opts.appId)}/sourcemaps?commitSha=${commitSha}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${opts.token}`, 'Content-Type': 'application/json' },
    body,
  });
  if (res.status === 409) return { status: 'exists', count, digest };
  const json = (await res.json().catch(() => ({}))) as { assetDigest?: string; expiresAt?: number; error?: string };
  if (res.status !== 201) throw new Error(`upload refused (HTTP ${res.status}): ${json.error ?? 'no detail'}`);
  if (json.assetDigest !== digest) throw new Error(`manifest digest ${json.assetDigest ?? '(none)'} does not match the uploaded bundle ${digest}`);
  return { status: 'uploaded', count, digest, expiresAt: json.expiresAt ?? 0 };
}

function defaultDir(): string {
  for (const d of ['web/dist', 'dist']) {
    try { if (statSync(d).isDirectory()) return d; } catch { /* next */ }
  }
  return 'dist';
}

export const sourcemapsCommand = new Command('sourcemaps')
  .description('Private browser source maps for crash symbolication (ADR-008 decision 7).')
  .addCommand(
    new Command('upload')
      .description("Upload a build's source maps to the platform's private store, then remove them from the build.")
      .option('--dir <dir>', 'build output directory (default: web/dist or dist)')
      .option('--app <appId>', 'app id (default: the GitHub repository name)')
      .option('--commit <sha>', 'commit the build was made from (default: $GITHUB_SHA)')
      .option('--keep-maps', 'do not delete the maps from the build afterwards')
      .action(async (opts: { dir?: string; app?: string; commit?: string; keepMaps?: boolean }) => {
        const dir = opts.dir ?? defaultDir();
        const appId = opts.app ?? process.env.GITHUB_REPOSITORY?.split('/')[1] ?? '';
        const commitSha = opts.commit ?? process.env.GITHUB_SHA ?? '';
        const maps = findSourceMaps(dir);
        try {
          if (!appId) throw new Error('--app is required outside GitHub Actions');
          const outcome = await uploadSourceMaps({ dir, appId, commitSha, token: await oidcToken(), apiBase: process.env.PAS_API_URL });
          process.stdout.write(outcome.status === 'uploaded'
            ? `✓ Uploaded ${outcome.count} source map(s) for ${appId}@${commitSha.slice(0, 7)} (sha256 ${outcome.digest.slice(0, 12)}…, verified)\n`
            : `✓ Source maps for ${appId}@${commitSha.slice(0, 7)} were already uploaded (releases are immutable)\n`);
        } catch (e) {
          process.stderr.write(`✗ ${(e as Error).message}\n`);
          process.exitCode = 1;
        } finally {
          // Whatever happened above, the maps must not reach the public upload.
          if (!opts.keepMaps) process.stdout.write(`Removed ${stripSourceMaps(dir, maps)} source map(s) from ${dir}\n`);
        }
      }),
  );
