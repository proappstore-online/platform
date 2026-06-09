import { spawn } from 'node:child_process';
import { access, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { resolveToken } from './lib/config.js';

const TEMPLATE_REPO = 'proappstore-online/template-app';
const PAS_API = 'https://api.proappstore.online';

const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.html', '.htm', '.css', '.scss', '.yaml', '.yml', '.toml', '.svg',
]);

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.cache']);

interface CreateOptions {
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

  // Step 1: Clone template
  process.stdout.write(`  [1/4] Cloning template...\n`);
  await run('git', ['clone', '--depth=1', `https://github.com/${TEMPLATE_REPO}.git`, targetDir]);
  await rm(join(targetDir, '.git'), { recursive: true, force: true });

  // Step 2: Replace APPNAME placeholders
  process.stdout.write(`  [2/4] Configuring for ${appId}...\n`);
  const substitutionCount = await substituteAppName(targetDir, appId, appName);

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
          }),
        });
        const data = (await res.json()) as { appId: string; steps: { name: string; status: string; detail: string }[] };
        for (const step of data.steps) {
          const icon = step.status === 'ok' ? '+' : step.status === 'skip' ? '-' : '!';
          process.stdout.write(`    [${icon}] ${step.name}: ${step.detail}\n`);
        }

        const dbStep = data.steps.find(s => s.name === 'create_d1' && s.status === 'ok');
        if (dbStep) {
          const configPath = join(targetDir, '.pas.json');
          writeFileSync(configPath, JSON.stringify({
            appId,
            dataApiBase: `https://pas-data-${appId}.serge-the-dev.workers.dev`,
            d1DatabaseId: dbStep.detail.match(/\(([^)]+)\)/)?.[1] || '',
          }, null, 2));
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
  Docs:    https://kb.proappstore.online/platform/
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
