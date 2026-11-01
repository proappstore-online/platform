import { readFile, readdir } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import { Command } from 'commander';
import { bearer, dieFromHttp, requireSession, resolveAppIdOrExit } from './secret.js';

/**
 * `pas storage import <dir>` (#515): owner bulk upload of existing files (a
 * Firebase port's Storage export above all) into an app's storage bucket.
 * Uploads through the SAME route a normal upload uses — `PUT
 * /v1/apps/:appId/storage/_public/<path>` (`routes/storage.ts`) — one file at
 * a time, never a parallel upload path. Prints a manifest mapping each local
 * file's relative path to its new storage key, so rows that store an old URL
 * can be rewritten before `pas data import` (name local files after the old
 * URL, or an id the D1 rows already carry, so the mapping is useful).
 */

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
};

function contentTypeOf(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/** Every file under `dir`, recursively, as POSIX-style paths relative to `dir`. */
async function walk(dir: string, root: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full, root));
    else out.push(relative(root, full).split(sep).join('/'));
  }
  return out;
}

export interface StorageImportEntry {
  path: string;
  key: string;
  size: number;
}

export async function importStorage(opts: { dir: string; app: string | undefined; prefix?: string | undefined }): Promise<StorageImportEntry[]> {
  const cfg = await requireSession();
  const appId = await resolveAppIdOrExit(opts.app);
  const prefix = (opts.prefix ?? '').replace(/^\/+|\/+$/g, '');
  const files = await walk(opts.dir, opts.dir);
  if (files.length === 0) throw new Error(`${opts.dir}: no files found`);

  const manifest: StorageImportEntry[] = [];
  for (const relPath of files) {
    const storagePath = `_public/${prefix ? `${prefix}/` : ''}${relPath}`;
    const body = await readFile(join(opts.dir, relPath));
    const res = await fetch(`${cfg.apiBase}/v1/apps/${appId}/storage/${storagePath}`, {
      method: 'PUT',
      headers: { ...bearer(cfg), 'Content-Type': contentTypeOf(relPath) },
      body: new Uint8Array(body),
    });
    if (!res.ok) await dieFromHttp(res, `upload ${relPath}`);
    const { key } = (await res.json()) as { key: string };
    manifest.push({ path: relPath, key, size: body.byteLength });
  }
  return manifest;
}

async function runStorageImport(dir: string, opts: { app?: string; prefix?: string; json?: boolean }): Promise<void> {
  const manifest = await importStorage({ dir, app: opts.app, prefix: opts.prefix });
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    return;
  }
  for (const entry of manifest) process.stdout.write(`${entry.path} -> ${entry.key} (${entry.size} bytes)\n`);
  process.stdout.write(`${manifest.length} file(s) uploaded.\n`);
}

export const storageCommand = new Command('storage')
  .description('Owner bulk upload of existing files into an app\'s storage.')
  .addCommand(
    new Command('import')
      .description('Upload every file under <dir> into storage, under _public/[prefix/]<relative path>. Prints a path -> key manifest.')
      .argument('<dir>', 'local directory to upload, recursively')
      .option('--app <id>', 'app id (defaults to package.json name in cwd)')
      .option('--prefix <path>', 'key prefix under _public/ (defaults to none)')
      .option('--json', 'Output the manifest as JSON.')
      .action(runStorageImport),
  );
