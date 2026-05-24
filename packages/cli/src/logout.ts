import { Command } from 'commander';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_FILE = join(homedir(), '.proappstore', 'config.json');

export const logoutCommand = new Command('logout')
  .description('Sign out and clear the local session.')
  .action(async () => {
    try {
      await rm(CONFIG_FILE);
      process.stdout.write('Signed out.\n');
    } catch {
      process.stdout.write('Already signed out.\n');
    }
  });
