/**
 * Browser source maps as private release artifacts (#393, ADR-008 decision 7).
 *
 * A release is ONE bundle per app and commit: `{ "files": { "<asset path>": <v3
 * source map> } }` — a Vite build emits a map per chunk, and every chunk of the
 * release must resolve. The bundle lives in the private STORAGE bucket under
 * `_sourcemaps/{appId}/{commitSha}/bundle.json` (no app id begins with `_`, so it
 * is never under an app's own storage prefix), with its SHA-256 in the manifest.
 *
 * Symbolication reads only the storage key named by the release's manifest row,
 * checks the digest, and maps a frame only when the frame's asset path is a key
 * of that bundle. A frame's URL is parsed for its path and never fetched.
 */

import { originalPositionFor, TraceMap } from '@jridgewell/trace-mapping';

const SOURCEMAP_PREFIX = '_sourcemaps';
/** Retention of a release's maps: the log-detail window (logs-prune RETENTION_DAYS). */
export const SOURCEMAP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** One release's bundle. Parsed whole on read, so bounded well inside a Worker's memory. */
export const MAX_BUNDLE_BYTES = 20 * 1024 * 1024;
/**
 * #442: total bundle bytes one request may hold. Each loaded release is fully read, hashed,
 * decoded and parsed (several copies of its size at once) and stays in memory for the whole
 * request, so three 20 MB releases could exceed the Worker's 128 MB limit.
 */
export const MAX_REQUEST_BUNDLE_BYTES = 24 * 1024 * 1024;
const MAX_BUNDLE_FILES = 500;
export const MAX_FRAMES = 50;
export const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;
/** A relative asset path: no scheme, no leading slash, no `..`, no backslash. */
const ASSET_PATH_RE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._~@+-]+(?:\/[A-Za-z0-9._~@+-]+)*$/;

export interface RawFrame { source: string; line: number; col: number }
interface SymbolicatedFrame {
  source: string;
  line: number;
  col: number;
  originalSource?: string;
  originalLine?: number;
  originalCol?: number;
  name?: string;
  /** True when this frame could not be mapped inside the release (unknown file or position). */
  unresolved?: true;
}
type SymbolicationStatus = 'ok' | 'missing' | 'mismatched' | 'unavailable';
export interface SymbolicationResult { status: SymbolicationStatus; frames: SymbolicatedFrame[]; rawStack?: string }

interface Env { DB: D1Database; STORAGE: R2Bucket }
type Bundle = { files: Record<string, unknown> };

export function sourcemapStorageKey(appId: string, commitSha: string): string {
  return `${SOURCEMAP_PREFIX}/${appId}/${commitSha}/bundle.json`;
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Why a bundle is unacceptable, or null when it is a well-formed release bundle. */
export function bundleProblem(bytes: ArrayBuffer): string | null {
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(bytes)); } catch { return 'bundle is not JSON'; }
  const files = (parsed as Partial<Bundle> | null)?.files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) return 'bundle.files must be an object of asset path → source map';
  const entries = Object.entries(files);
  if (entries.length === 0) return 'bundle.files is empty';
  if (entries.length > MAX_BUNDLE_FILES) return `bundle.files has more than ${MAX_BUNDLE_FILES} maps`;
  for (const [path, map] of entries) {
    if (path.length > 256 || !ASSET_PATH_RE.test(path)) return `invalid asset path: ${JSON.stringify(path.slice(0, 80))}`;
    const m = map as { version?: unknown; mappings?: unknown } | null;
    if (!m || typeof m !== 'object' || m.version !== 3 || typeof m.mappings !== 'string') return `not a v3 source map: ${path}`;
  }
  return null;
}

/**
 * Store a release bundle. The caller has already reserved the manifest row, so
 * nothing ever overwrites a release that exists.
 */
export async function uploadSourceMap(env: Env, appId: string, commitSha: string, bundle: ArrayBuffer): Promise<{ storageKey: string; assetDigest: string }> {
  const storageKey = sourcemapStorageKey(appId, commitSha);
  const assetDigest = await sha256Hex(bundle);
  await env.STORAGE.put(storageKey, bundle, { httpMetadata: { contentType: 'application/json' }, customMetadata: { sha256: assetDigest } });
  return { storageKey, assetDigest };
}

/** The asset path a frame names: a URL's pathname or a path, without query, hash or leading slash. Never fetched. */
export function framePath(source: string): string {
  let path = source;
  try { path = new URL(source).pathname; } catch { /* already a path */ }
  return path.split(/[?#]/)[0]!.replace(/^\/+/, '');
}

function unresolved(frames: RawFrame[]): SymbolicatedFrame[] {
  return frames.map((f) => ({ ...f, unresolved: true as const }));
}

/** A loaded release: its maps, or why it cannot be used. Load once, map many stacks. */
export type Release = { status: 'ok'; files: Record<string, unknown>; maps: Map<string, TraceMap> } | { status: Exclude<SymbolicationStatus, 'ok'> };

/**
 * Load the release `commitSha` of `appId` — that release only, never another.
 * `missing` (no such release), `unavailable` (expired, or its bundle is gone),
 * `mismatched` (stored bytes differ from the manifest digest), `ok`.
 */
export async function loadRelease(
  env: Env, appId: string, commitSha: string, nowMs: number = Date.now(),
  /** Shared across one request's loads: a release whose stored size no longer fits is `unavailable` and never read. */
  budget?: { remaining: number },
): Promise<Release> {
  const row = await env.DB.prepare(
    'SELECT asset_digest, storage_key, expires_at, status FROM release_sourcemap_manifests WHERE app_id = ? AND commit_sha = ?',
  ).bind(appId, commitSha).first<{ asset_digest: string; storage_key: string; expires_at: number; status: string }>();
  if (!row) return { status: 'missing' };
  if (row.status !== 'active' || row.expires_at <= nowMs) return { status: 'unavailable' };

  const object = await env.STORAGE.get(row.storage_key);
  if (!object) return { status: 'unavailable' };
  if (budget) {
    if (object.size > budget.remaining) { await object.body.cancel().catch(() => {}); return { status: 'unavailable' }; }
    budget.remaining -= object.size;
  }
  const bytes = await object.arrayBuffer();
  if (bytes.byteLength > MAX_BUNDLE_BYTES || (await sha256Hex(bytes)) !== row.asset_digest) return { status: 'mismatched' };
  try {
    const bundle = JSON.parse(new TextDecoder().decode(bytes)) as Bundle;
    return { status: 'ok', files: bundle.files, maps: new Map() };
  } catch {
    return { status: 'mismatched' };
  }
}

/** Map frames through a loaded release; any status but `ok` leaves them raw and unresolved. */
export function mapFrames(release: Release, frames: RawFrame[]): SymbolicationResult {
  if (release.status !== 'ok') return { status: release.status, frames: unresolved(frames) };
  const out = frames.map((frame): SymbolicatedFrame => {
    const path = framePath(frame.source);
    const raw = Object.prototype.hasOwnProperty.call(release.files, path) ? release.files[path] : undefined;
    if (!raw) return { ...frame, unresolved: true };
    let map = release.maps.get(path);
    if (!map) {
      try { map = new TraceMap(raw as ConstructorParameters<typeof TraceMap>[0]); } catch { return { ...frame, unresolved: true }; }
      release.maps.set(path, map);
    }
    // Stack columns are 1-based; source-map columns are 0-based.
    const pos = originalPositionFor(map, { line: frame.line, column: Math.max(0, frame.col - 1) });
    if (pos.source === null || pos.line === null || pos.column === null) return { ...frame, unresolved: true };
    return {
      ...frame,
      originalSource: pos.source,
      originalLine: pos.line,
      originalCol: pos.column + 1,
      ...(pos.name ? { name: pos.name } : {}),
    };
  });
  return { status: 'ok', frames: out };
}

/** Map `frames` through the release `commitSha` of `appId` — that release only. */
export async function symbolicateStack(env: Env, appId: string, commitSha: string, frames: RawFrame[], nowMs: number = Date.now()): Promise<SymbolicationResult> {
  return mapFrames(await loadRelease(env, appId, commitSha, nowMs), frames);
}

/**
 * Frames from a stack string, V8 (`at fn (url:1:2)`) or Firefox/Safari
 * (`fn@url:1:2`). Only `http(s)` URLs and absolute paths are frames; at most
 * MAX_FRAMES. Correlation only — never fetched.
 */
export function parseStack(stack: string): RawFrame[] {
  const frames: RawFrame[] = [];
  for (const line of stack.split('\n')) {
    const m = /((?:https?:\/\/|\/)[^\s()@]+):(\d+):(\d+)\)?\s*$/.exec(line.trim());
    if (!m) continue;
    frames.push({ source: m[1]!.slice(0, 2048), line: Number(m[2]), col: Number(m[3]) });
    if (frames.length >= MAX_FRAMES) break;
  }
  return frames;
}

/** Releases kept as `expired` tombstones (so they read `unavailable`, not `missing`) until a year after upload. */
const SOURCEMAP_TOMBSTONE_MS = 365 * 24 * 60 * 60 * 1000;
const SWEEP_BATCH = 100;

/**
 * Daily retention sweep (ADR-008 decision 7). Bounded at SWEEP_BATCH per step:
 *  1. active releases past `expires_at`: delete the private bundle, mark `expired`;
 *  2. tombstones a year past upload: delete the row.
 * A release mid-sweep is never half-gone: the row is marked only after its object is deleted.
 */
export async function sweepSourceMaps(env: Env, nowMs: number = Date.now()): Promise<{ expired: number; removed: number }> {
  const due = await env.DB.prepare(
    "SELECT id, storage_key FROM release_sourcemap_manifests WHERE status = 'active' AND expires_at <= ? ORDER BY expires_at LIMIT ?",
  ).bind(nowMs, SWEEP_BATCH).all<{ id: number; storage_key: string }>();
  let expired = 0;
  for (const row of due.results ?? []) {
    await env.STORAGE.delete(row.storage_key);
    await env.DB.prepare("UPDATE release_sourcemap_manifests SET status = 'expired' WHERE id = ?").bind(row.id).run();
    expired += 1;
  }
  const removed = await env.DB.prepare(
    "DELETE FROM release_sourcemap_manifests WHERE id IN (SELECT id FROM release_sourcemap_manifests WHERE status = 'expired' AND uploaded_at <= ? LIMIT ?)",
  ).bind(nowMs - SOURCEMAP_TOMBSTONE_MS, SWEEP_BATCH).run();
  return { expired, removed: removed.meta?.changes ?? 0 };
}
