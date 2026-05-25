#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { checkCommand } from './check.js';
import { createApp } from './create.js';
import { domainCommand } from './domain.js';
import { loginCommand } from './login.js';
import { logoutCommand } from './logout.js';
import { whoamiCommand } from './whoami.js';
import { publishApp } from './publish.js';
import { secretCommand } from './secret.js';
import { proxyCommand } from './proxy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version: string };

const program = new Command();

program
  .name('pas')
  .description('ProAppStore CLI — create, develop, and publish pro apps.')
  .version(pkg.version);

program
  .command('create <app-id>')
  .description('Scaffold + provision a new pro app. Creates D1 database and configures platform resources.')
  .option('--skip-install', 'Skip pnpm install')
  .option('--skip-git', 'Skip git init')
  .option('--skip-provision', 'Skip D1 + platform provisioning')
  .option('--token <token>', 'Session token (or set PAS_SESSION_TOKEN env var)')
  .option('--repo <owner/name>', 'Create a GitHub repo and push (e.g. my-org/my-app)')
  .action(async (appId: string, opts: { skipInstall?: boolean; skipGit?: boolean; skipProvision?: boolean; token?: string; repo?: string }) => {
    await createApp(appId, opts);
  });

program.addCommand(loginCommand);
program.addCommand(logoutCommand);
program.addCommand(whoamiCommand);

program
  .command('publish')
  .description('Provision platform resources for this app (CF Pages, D1 database, Data Worker).')
  .option('--name <name>', 'Display name (defaults to Title Case of package.json name)')
  .option('--category <category>', 'Storefront category (e.g. social, productivity)')
  .option('--description <description>', 'Short description for the storefront listing')
  .option('--icon <icon>', 'Icon HTML entity, e.g. "&#128197;"')
  .option('--icon-bg <color>', 'Icon background hex color')
  .option('--pro-features <list>', 'Comma-separated list of features the pro subscription unlocks')
  .option('--token <token>', 'Session token (or set PAS_SESSION_TOKEN env var)')
  .action(async (opts: { name?: string; category?: string; description?: string; icon?: string; iconBg?: string; proFeatures?: string; token?: string }) => {
    await publishApp(opts);
  });

program.addCommand(checkCommand);
program.addCommand(domainCommand);
program.addCommand(secretCommand);
program.addCommand(proxyCommand);

program.parseAsync().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`pas: ${msg}\n`);
  process.exit(1);
});
