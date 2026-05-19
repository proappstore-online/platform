import type { FileSource } from '../lib/file-source.js';
import type { CheckResult } from '../types.js';

/**
 * `.env.production` is a frequent accidental commit — Vite reads it at
 * build time, and it's the file most likely to contain real API keys
 * for the production deploy. The platform's templates instruct creators
 * to use Cloudflare Pages env vars or Wrangler secrets instead. This
 * check is a safety net: even if the creator's gitignore misses it, we
 * fail compliance before publish.
 *
 * Scope: any `.env.production` file anywhere in the repo. We don't try
 * to differentiate "this one's empty" from "this one has secrets" —
 * the file shouldn't exist at all.
 */
export async function checkNoEnvProduction(source: FileSource): Promise<CheckResult> {
  const offenders: string[] = [];
  for await (const path of source.list()) {
    const base = path.split('/').pop() ?? '';
    if (base === '.env.production') offenders.push(path);
  }
  if (offenders.length === 0) {
    return {
      name: 'No .env.production',
      status: 'pass',
      detail: 'no production env files committed',
    };
  }
  return {
    name: 'No .env.production',
    status: 'fail',
    detail: `${offenders.length} .env.production file(s): ${offenders.join(', ')}`,
    suggestions: [
      'Delete the file and add `.env.production` to .gitignore.',
      'Use Cloudflare Pages → Settings → Environment Variables for production secrets instead.',
    ],
  };
}
