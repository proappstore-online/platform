#!/usr/bin/env node
import { Command } from 'commander';
import { createApp } from './create.js';
import { publishApp } from './publish.js';

const program = new Command();

program
  .name('pas')
  .description('ProAppStore CLI — create, develop, and publish pro apps.')
  .version('1.0.0');

program
  .command('create <app-id>')
  .description('Scaffold + provision a new pro app. Creates D1 database and configures platform resources.')
  .option('--skip-install', 'Skip pnpm install')
  .option('--skip-git', 'Skip git init')
  .option('--skip-provision', 'Skip D1 + platform provisioning')
  .option('--token <token>', 'FAS session token (or set FAS_SESSION_TOKEN env var)')
  .action(async (appId: string, opts: { skipInstall?: boolean; skipGit?: boolean; skipProvision?: boolean; token?: string }) => {
    await createApp(appId, opts);
  });

program
  .command('login')
  .description('Sign in with GitHub (shared identity with `fas`).')
  .action(() => {
    process.stdout.write(
      'pas login is not yet implemented.\n' +
        'For now: run `fas login` (from @freeappstore/cli) — pro shares the same identity.\n',
    );
    process.exit(2);
  });

program
  .command('publish')
  .description('Publish the current repo to ProAppStore: GitHub repo, CF Pages, DNS, D1 database, registry entry.')
  .option('--name <name>', 'Display name (defaults to Title Case of package.json name)')
  .option('--category <category>', 'Storefront category (e.g. social, productivity)')
  .option('--description <description>', 'Short description for the storefront listing')
  .option('--icon <icon>', 'Icon HTML entity, e.g. "&#128197;"')
  .option('--icon-bg <color>', 'Icon background hex color')
  .option('--pro-features <list>', 'Comma-separated list of features the pro subscription unlocks')
  .option('--token <token>', 'FAS session token (or set FAS_SESSION_TOKEN env var)')
  .action(async (opts: { name?: string; category?: string; description?: string; icon?: string; iconBg?: string; proFeatures?: string; token?: string }) => {
    await publishApp(opts);
  });

program.parseAsync().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`pas: ${msg}\n`);
  process.exit(1);
});
