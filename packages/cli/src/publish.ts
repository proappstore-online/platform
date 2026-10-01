import { resolve } from 'node:path';
import { resolveToken } from './lib/config.js';
import { readJsonIfExists } from './lib/json-file.js';

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
  // #178: template provenance written by `pas create` (local, git-ignored).
  const pasConfig = readJsonIfExists<{ template?: string; templateRev?: string }>(resolve(cwd, '.pas.json'));
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
        ...(pasConfig?.template ? { template: pasConfig.template } : {}),
        ...(pasConfig?.templateRev ? { templateRev: pasConfig.templateRev } : {}),
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
    const mcpManifest = readJsonIfExists<{ tools?: unknown[]; page_meta?: unknown; sitemap?: unknown; operator?: unknown; operator_view?: unknown; visibility?: unknown }>(mcpManifestPath);
    const manifestTools = Array.isArray(mcpManifest?.tools) ? mcpManifest.tools : [];
    // #259: visibility registers with the tools, so a manifest that declares it
    // registers even with no tools — or a tool-less private app would go live public.
    const declaresVisibility = mcpManifest?.visibility !== undefined;
    const isPrivate = (mcpManifest?.visibility as { mode?: unknown } | undefined)?.mode === 'private';
    let privateRegistrationFailed = false;
    if (mcpManifest && (manifestTools.length > 0 || declaresVisibility)) {
      process.stdout.write(`\n  Registering ${manifestTools.length} MCP tool(s)${declaresVisibility ? ' and visibility' : ''}...\n`);
      try {
        const toolsRes = await fetch(`${PAS_API}/v1/apps/${appId}/tools`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          // page_meta / sitemap (#210), operator (#229), operator_view (#240) and visibility (#259) register with the tools and are replaced with them.
          body: JSON.stringify({ tools: manifestTools, page_meta: mcpManifest.page_meta, sitemap: mcpManifest.sitemap, operator: mcpManifest.operator, operator_view: mcpManifest.operator_view, visibility: mcpManifest.visibility }),
        });
        if (toolsRes.ok) {
          const toolsData = (await toolsRes.json()) as { registered: number; schedules?: Array<{ name: string; cron: string }> };
          process.stdout.write(`  [+] MCP tools: ${toolsData.registered} tool(s) registered\n`);
          for (const schedule of toolsData.schedules ?? []) {
            process.stdout.write(`  [+] Scheduled action: ${schedule.name} (${schedule.cron} UTC)\n`);
          }
        } else {
          const errText = await toolsRes.text();
          process.stdout.write(`  [!] MCP tools: ${errText}\n`);
          privateRegistrationFailed = isPrivate;
        }
      } catch (e) {
        process.stdout.write(`  [!] MCP tools: ${e}\n`);
        privateRegistrationFailed = isPrivate;
      }
    }
    if (privateRegistrationFailed) {
      process.stderr.write(
        `\n  mcp.json declares visibility: private, but it did not register — the app would be served PUBLICLY.\n` +
          `  Fix the error above and re-run pas publish (it is idempotent) before pushing any code.\n`,
      );
      process.exit(1);
    }
  }

  if (data.success) {
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
