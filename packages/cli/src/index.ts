#!/usr/bin/env node
import { Command } from 'commander';

const program = new Command();

program
  .name('pas')
  .description('ProAppStore CLI — sign in, scaffold, and publish paid apps.')
  .version('0.0.0');

program
  .command('login')
  .description('Sign in with GitHub (shared identity with `fas`).')
  .action(() => {
    process.stdout.write(
      'pas login is not yet implemented in v0 skeleton.\n' +
        'For now: run `fas login` (from @freeappstore/cli) — pro shares the same identity.\n',
    );
    process.exit(2);
  });

program
  .command('init <app-id>')
  .description('Scaffold a new pro app from a template.')
  .action(() => {
    process.stdout.write('pas init: not yet implemented (skeleton).\n');
    process.exit(2);
  });

program
  .command('publish')
  .description('Open the ProAppStore publisher portal for the current repo.')
  .action(() => {
    process.stdout.write('pas publish: not yet implemented (skeleton).\n');
    process.exit(2);
  });

program.parseAsync().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`pas: ${msg}\n`);
  process.exit(1);
});
