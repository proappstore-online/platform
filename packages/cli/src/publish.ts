import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

interface PublishOptions {
  name?: string;
  category?: string;
  description?: string;
  icon?: string;
  iconBg?: string;
  proFeatures?: string;
  token?: string;
}

const PAS_API = 'https://api.proappstore.online';

function readJsonIfExists<T = unknown>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function toTitleCase(id: string): string {
  return id
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Publish an existing repo to ProAppStore.
 *
 * Reads the local package.json to discover the app id, then calls
 * /v1/provision on the PAS backend. The backend delegates GitHub + CF Pages
 * + DNS + registry to FAS admin via service binding, and runs D1 + Data
 * Worker locally. Idempotent — re-running on a partially-provisioned app
 * fills in the missing pieces.
 */
export async function publishApp(opts: PublishOptions): Promise<void> {
  const cwd = process.cwd();
  const pkg = readJsonIfExists<{ name?: string; description?: string }>(resolve(cwd, 'package.json'));
  if (!pkg || !pkg.name) {
    process.stderr.write(
      'pas publish: no package.json with a `name` field in the current directory.\n' +
        'Run this from the root of a pas-scaffolded app, or use `pas create` first.\n',
    );
    process.exit(1);
  }

  const appId = pkg.name;
  if (!/^[a-z][a-z0-9-]*$/.test(appId) || appId.length > 58) {
    process.stderr.write(`pas publish: package.json name "${appId}" is not a valid app id (lowercase, hyphens, max 58 chars).\n`);
    process.exit(1);
  }

  const token = opts.token || process.env.FAS_SESSION_TOKEN;
  if (!token) {
    process.stderr.write(
      'pas publish: no auth token. Set FAS_SESSION_TOKEN env var or use --token.\n' +
        'Tokens come from `fas login` (shared identity with the free side).\n',
    );
    process.exit(1);
  }

  const name = opts.name || toTitleCase(appId);
  const description = opts.description || pkg.description || `${name} — pro app on ProAppStore.`;
  const proFeatures = opts.proFeatures
    ? opts.proFeatures
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

  process.stdout.write(`\n  Publishing ${name} (${appId})...\n\n`);

  let res: Response;
  try {
    res = await fetch(`${PAS_API}/v1/provision`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appId,
        name,
        description,
        category: opts.category,
        icon: opts.icon,
        iconBg: opts.iconBg,
        proFeatures,
      }),
    });
  } catch (e) {
    process.stderr.write(`  Network error: ${e}\n`);
    process.exit(1);
  }

  // 207 (multi-status) means some steps failed but the call completed; the
  // body still has the per-step breakdown so we render it the same way.
  if (res.status !== 200 && res.status !== 207) {
    const text = await res.text();
    process.stderr.write(`  pas publish failed (${res.status}): ${text}\n`);
    process.exit(1);
  }

  const data = (await res.json()) as {
    appId: string;
    steps: { name: string; status: string; detail: string }[];
    dataWorkerUrl: string;
    pagesUrl: string;
    success: boolean;
  };

  for (const step of data.steps) {
    const icon = step.status === 'ok' ? '+' : step.status === 'skip' ? '-' : '!';
    process.stdout.write(`  [${icon}] ${step.name}: ${step.detail}\n`);
  }

  if (data.success) {
    process.stdout.write(`\n  Published. Push your code to deploy:\n`);
    process.stdout.write(`    git push origin main\n\n`);
    process.stdout.write(`  Live URL:        https://${appId}.proappstore.online\n`);
    if (data.pagesUrl) process.stdout.write(`  Pages preview:   ${data.pagesUrl}\n`);
    if (data.dataWorkerUrl) process.stdout.write(`  Data Worker:     ${data.dataWorkerUrl}\n`);
    process.stdout.write('\n');
  } else {
    process.stderr.write(`\n  Some steps failed. Fix the failing step and retry — pas publish is idempotent.\n`);
    process.exit(1);
  }
}
