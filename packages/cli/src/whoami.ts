import { Command } from 'commander';
import { readConfig } from './lib/config.js';

export const whoamiCommand = new Command('whoami')
  .description('Show the currently signed-in user.')
  .action(async () => {
    const config = await readConfig();
    if (config.github?.login) {
      process.stdout.write(`@${config.github.login}\n`);
    } else {
      process.stdout.write('Not signed in. Run `pas login` first.\n');
      process.exit(1);
    }
  });
