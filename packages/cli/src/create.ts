import { spawn } from 'node:child_process';
import { access, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { writeFileSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { resolveToken } from './lib/config.js';
import { writeOgImage } from './og-image.js';

const TEMPLATE_REPO = 'proappstore-online/template-app';
/** #178: the public approved-template catalogue (published by the docs build). */
const CATALOGUE_URL = 'https://docs.proappstore.online/templates/catalogue.json';
const DEFAULT_TEMPLATE_ID = 'template-app';

interface CatalogueTemplate {
  id: string;
  repo: string;
  ref: string;
  status: 'approved' | 'deprecated' | 'withdrawn';
  default: boolean;
  deprecation: { since: string; replaced_by: string | null; reason: string } | null;
}

/**
 * Resolve the template to scaffold from against the public catalogue (#178).
 * Unknown/withdrawn ids are refused with the approved list; deprecated ones
 * warn; when the catalogue is unreachable the canonical default still works
 * (offline scaffolding must not break), but a non-default id cannot be
 * validated and is refused.
 */
export async function resolveTemplate(requested: string | undefined, fetchImpl: typeof fetch = fetch): Promise<{ id: string; repo: string; ref: string; warnings: string[] }> {
  let templates: CatalogueTemplate[] | null = null;
  try {
    const res = await fetchImpl(CATALOGUE_URL, { signal: AbortSignal.timeout(5000) });
    if (res.ok) templates = ((await res.json()) as { templates: CatalogueTemplate[] }).templates;
  } catch { /* offline: fall through */ }
  const want = requested?.trim() || DEFAULT_TEMPLATE_ID;
  if (!templates) {
    if (want !== DEFAULT_TEMPLATE_ID) throw new Error(`cannot validate template "${want}": the catalogue at ${CATALOGUE_URL} is unreachable. Retry online or omit --template.`);
    return { id: DEFAULT_TEMPLATE_ID, repo: TEMPLATE_REPO, ref: 'main', warnings: ['catalogue unreachable — using the canonical default template'] };
  }
  const t = templates.find((x) => x.id === want || x.repo === want || x.repo.split('/')[1] === want);
  const approved = templates.filter((x) => x.status === 'approved').map((x) => x.id);
  if (!t) throw new Error(`unknown template "${want}". Approved templates: ${approved.join(', ')}. See https://docs.proappstore.online/templates/`);
  if (t.status === 'withdrawn') throw new Error(`template "${t.id}" is withdrawn${t.deprecation?.replaced_by ? ` — use ${t.deprecation.replaced_by}` : ''}.`);
  const warnings: string[] = [];
  if (t.status === 'deprecated') warnings.push(`template "${t.id}" is deprecated${t.deprecation?.replaced_by ? ` — prefer ${t.deprecation.replaced_by}` : ''}${t.deprecation?.reason ? `: ${t.deprecation.reason}` : ''}`);
  return { id: t.id, repo: t.repo, ref: t.ref, warnings };
}
const PAS_API = 'https://api.proappstore.online';

const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.html', '.htm', '.css', '.scss', '.yaml', '.yml', '.toml', '.svg',
]);

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.cache']);

interface CreateOptions {
  /** #178: approved template id (default template-app), validated against the public catalogue. */
  template?: string;
  skipInstall?: boolean;
  skipGit?: boolean;
  skipProvision?: boolean;
  token?: string;
  repo?: string;
}

function toTitleCase(id: string): string {
  return id.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

export async function createApp(appId: string, opts: CreateOptions = {}): Promise<void> {
  if (!/^[a-z][a-z0-9-]*$/.test(appId) || appId.length > 58) {
    process.stderr.write(`Invalid app ID "${appId}". Use lowercase letters, numbers, hyphens. Max 58 chars.\n`);
    process.exit(1);
  }

  const targetDir = resolve(appId);
  if (await exists(targetDir)) {
    process.stderr.write(`Directory "${appId}" already exists.\n`);
    process.exit(1);
  }

  const appName = toTitleCase(appId);
  process.stdout.write(`\n  Creating ${appName}...\n\n`);

  // Step 1: Clone the approved template (#178) and record the exact revision.
  const template = await resolveTemplate(opts.template);
  for (const w of template.warnings) process.stdout.write(`  ! ${w}\n`);
  process.stdout.write(`  [1/4] Cloning template ${template.id} (${template.repo}@${template.ref})...\n`);
  await run('git', ['clone', '--depth=1', '--branch', template.ref, `https://github.com/${template.repo}.git`, targetDir]);
  const templateRev = (await runCapture('git', ['rev-parse', 'HEAD'], targetDir)).trim();
  await rm(join(targetDir, '.git'), { recursive: true, force: true });
  process.stdout.write(`        source revision ${templateRev.slice(0, 12)}\n`);

  // #178: provenance is recorded locally regardless of provisioning, so a later
  // `pas publish` can forward the template id + revision to the platform.
  writePasConfig(targetDir, { appId, template: template.id, templateRev });

  // Step 2: Replace APPNAME placeholders
  process.stdout.write(`  [2/4] Configuring for ${appId}...\n`);
  const substitutionCount = await substituteAppName(targetDir, appId, appName);
  await writeOgImage(join(targetDir, 'web', 'public', 'og-image.png'), appName);

  // Step 3: Install
  if (!opts.skipInstall) {
    process.stdout.write(`  [3/4] Installing dependencies...\n`);
    try {
      await run('pnpm', ['install'], targetDir);
    } catch {
      process.stdout.write(`  [3/4] pnpm install failed. Run it manually.\n`);
    }
  } else {
    process.stdout.write(`  [3/4] Skipping install (--skip-install)\n`);
  }

  // Step 4: Init git + provision
  if (!opts.skipGit) {
    await run('git', ['init', '-q', '-b', 'main'], targetDir);
    await run('git', ['add', '-A'], targetDir);
    await run('git', ['commit', '-q', '-m', 'Initial commit from pas create'], targetDir);

    // Optional: create GitHub repo and push
    if (opts.repo) {
      try {
        process.stdout.write(`  Creating GitHub repo ${opts.repo}...\n`);
        await run('gh', ['repo', 'create', opts.repo, '--private', '--source', '.', '--remote', 'origin', '--push'], targetDir);
        process.stdout.write(`  [+] Repo created and pushed to ${opts.repo}\n`);
      } catch {
        process.stdout.write(`  [!] Failed to create repo. Create it manually:\n`);
        process.stdout.write(`      gh repo create ${opts.repo} --private\n`);
        process.stdout.write(`      git remote add origin https://github.com/${opts.repo}.git\n`);
        process.stdout.write(`      git push -u origin main\n`);
      }
    }
  }

  if (!opts.skipProvision) {
    const token = resolveToken(opts.token);
    if (token) {
      process.stdout.write(`  [4/4] Provisioning platform resources...\n`);
      try {
        const res = await fetch(`${PAS_API}/v1/provision`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            appId,
            name: appName,
            description: `${appName} — pro app on ProAppStore.`,
            skipCompliance: true,
            skipPublish: true,
            template: template.id,
            templateRev,
          }),
        });
        const data = (await res.json()) as { appId: string; steps: { name: string; status: string; detail: string }[] };
        for (const step of data.steps) {
          const icon = step.status === 'ok' ? '+' : step.status === 'skip' ? '-' : '!';
          process.stdout.write(`    [${icon}] ${step.name}: ${step.detail}\n`);
        }

        const dbStep = data.steps.find(s => s.name === 'create_d1' && s.status === 'ok');
        if (dbStep) {
          writePasConfig(targetDir, {
            appId,
            template: template.id,
            templateRev,
            dataApiBase: `https://data-${appId}.proappstore.online`,
            d1DatabaseId: dbStep.detail.match(/\(([^)]+)\)/)?.[1] || '',
          });
          process.stdout.write(`    Config written to .pas.json\n`);
        }
      } catch (e) {
        process.stdout.write(`    Provisioning failed: ${e}. You can provision later.\n`);
      }
    } else {
      process.stdout.write(`  [4/4] Skipping provision (no auth token). Run \`pas login\`, set PAS_SESSION_TOKEN, or use --token.\n`);
    }
  } else {
    process.stdout.write(`  [4/4] Skipping provision (--skip-provision)\n`);
  }

  const hasRemote = opts.repo && !opts.skipGit;
  process.stdout.write(`
  Done! Replaced APPNAME in ${substitutionCount} files.

  Next steps:
    cd ${appId}
    pnpm dev
${hasRemote ? `
  When ready to deploy:
    git push origin main
    pas publish
` : `
  When ready to deploy:
    1. Create a GitHub repo in your own account/org
    2. git remote add origin <your-repo-url>
    3. git push -u origin main
    4. pas publish
`}
  Docs:    https://docs.proappstore.online/
  Standard: https://docs.proappstore.online/standard/   (how to build + audit; set authMode: 'platform-cookie')
  Console: https://console.proappstore.online

`);
}

async function substituteAppName(dir: string, appId: string, appName: string): Promise<number> {
  let count = 0;
  for await (const file of walk(dir)) {
    if (!TEXT_EXTENSIONS.has(extname(file).toLowerCase())) continue;
    const content = await readFile(file, 'utf8');
    if (!content.includes('APPNAME')) continue;
    await writeFile(file, content.split('APPNAME').join(appId));
    count++;
  }
  return count;
}

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(join(dir, entry.name));
    } else if (entry.isFile()) {
      yield join(dir, entry.name);
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Like run(), but returns stdout (used for `git rev-parse`). */
async function runCapture(cmd: string, args: string[], cwd?: string): Promise<string> {
  const { execFile } = await import('node:child_process');
  return new Promise((resolvePromise, reject) => {
    execFile(cmd, args, { cwd }, (err, stdout) => (err ? reject(err) : resolvePromise(String(stdout))));
  });
}

function run(cmd: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolveFn, rejectFn) => {
    const child = spawn(cmd, args, { stdio: 'inherit', cwd });
    child.on('exit', (code) => {
      if (code === 0) resolveFn();
      else rejectFn(new Error(`${cmd} exited with code ${code}`));
    });
    child.on('error', rejectFn);
  });
}

/** Merge fields into <dir>/.pas.json (local, git-ignored). */
function writePasConfig(dir: string, fields: Record<string, unknown>): void {
  const configPath = join(dir, '.pas.json');
  let current: Record<string, unknown> = {};
  try { current = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>; } catch { /* first write */ }
  writeFileSync(configPath, JSON.stringify({ ...current, ...fields }, null, 2));
}
