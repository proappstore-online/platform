import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { resolveToken } from './lib/config.js';

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
 * Map a failing step's detail to an actionable next-step hint. Returns
 * null when the failure is generic ('Fix and retry' is enough). Hints are
 * shown indented under the failing step line.
 */
function hintForStep(name: string, detail: string): string | null {
  const d = detail.toLowerCase();
  if (name.toLowerCase().includes('analytics') && d.includes('auth')) {
    return (
      'CF Web Analytics token lacks the analytics scope.\n' +
      '→ Non-blocking — your app still ships; the analytics dashboard\n' +
      '  will be empty until the platform token is widened.'
    );
  }
  if (d.includes('repo') && d.includes('already exists')) {
    return (
      'Repo already exists on GitHub. `pas publish` is idempotent —\n' +
      'this step is harmless; the remaining steps still ran.'
    );
  }
  return null;
}

/**
 * Publish an existing repo to ProAppStore.
 *
 * Reads the local package.json to discover the app id, then calls
 * /v1/provision on the PAS backend which registers the R2 route,
 * D1 database, and Data Worker. Idempotent — re-running on a
 * partially-provisioned app fills in the missing pieces.
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

  const token = resolveToken(opts.token);
  if (!token) {
    process.stderr.write(
      'pas publish: no auth token. Run `pas login` first, or use --token.\n',
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
    appUrl: string;
    success: boolean;
  };

  for (const step of data.steps) {
    const icon = step.status === 'ok' ? '+' : step.status === 'skip' ? '-' : '!';
    process.stdout.write(`  [${icon}] ${step.name}: ${step.detail}\n`);
    if (step.status === 'fail') {
      const hint = hintForStep(step.name, step.detail);
      if (hint) {
        for (const line of hint.split('\n')) {
          process.stdout.write(`      ${line}\n`);
        }
      }
    }
  }

  if (data.success) {
    // ── Register MCP tools from mcp.json (if present) ──────────
    const mcpManifestPath = resolve(cwd, 'mcp.json');
    const mcpManifest = readJsonIfExists<{ tools?: unknown[] }>(mcpManifestPath);
    if (mcpManifest?.tools && Array.isArray(mcpManifest.tools) && mcpManifest.tools.length > 0) {
      process.stdout.write(`\n  Registering ${mcpManifest.tools.length} MCP tool(s)...\n`);
      try {
        const toolsRes = await fetch(`${PAS_API}/v1/apps/${appId}/tools`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ tools: mcpManifest.tools }),
        });
        if (toolsRes.ok) {
          const toolsData = (await toolsRes.json()) as { registered: number };
          process.stdout.write(`  [+] MCP tools: ${toolsData.registered} tool(s) registered\n`);
        } else {
          const errText = await toolsRes.text();
          process.stdout.write(`  [!] MCP tools: ${errText}\n`);
        }
      } catch (e) {
        process.stdout.write(`  [!] MCP tools: ${e}\n`);
      }
    }
  }

  if (data.success) {
    // Set R2 deploy secrets on external-org repos
    await ensureDeploySecrets(appId, token);

    process.stdout.write(`\n  Published. Push your code to deploy:\n`);
    process.stdout.write(`    git push origin main\n\n`);
    process.stdout.write(`  Live URL:        https://${appId}.proappstore.online\n`);
    if (data.dataWorkerUrl) process.stdout.write(`  Data Worker:     ${data.dataWorkerUrl}\n`);
    process.stdout.write('\n');
  } else {
    process.stderr.write(`\n  Some steps failed. Fix the failing step and retry — pas publish is idempotent.\n`);
    process.exit(1);
  }
}

/**
 * Check if an external-org repo needs R2 deploy secrets.
 * Repos in proappstore-online inherit org-level secrets automatically.
 * External repos need the secrets set manually (R2 tokens can't be
 * programmatically shared — they're created in the CF dashboard).
 */
async function ensureDeploySecrets(_appId: string, _token: string): Promise<void> {
  let remoteUrl: string;
  try {
    remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
  } catch {
    return;
  }

  const match = remoteUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (!match) return;
  const [, owner] = match;

  if (owner === 'proappstore-online') return;

  // External repo — check if R2 secrets are set
  const fullRepo = `${owner}/${match[2]}`;
  try {
    execFileSync('gh', ['--version'], { stdio: 'pipe' });
    const secrets = execFileSync('gh', ['secret', 'list', '-R', fullRepo], { encoding: 'utf8', stdio: 'pipe' });
    if (secrets.includes('R2_ACCESS_KEY_ID')) return;
  } catch {
    // gh not available or can't list secrets
  }

  process.stdout.write(`\n  Your repo is outside the proappstore-online org.\n`);
  process.stdout.write(`  Set these GitHub Actions secrets on ${fullRepo}:\n`);
  process.stdout.write(`    R2_ACCESS_KEY_ID      (from CF Dashboard → R2 → API Tokens)\n`);
  process.stdout.write(`    R2_SECRET_ACCESS_KEY\n`);
  process.stdout.write(`    R2_ACCOUNT_ID\n\n`);
}
