import { Command } from 'commander';
import { readConfig, resolveToken } from './lib/config.js';

export async function runWhoami(): Promise<void> {
  const config = await readConfig();
  // #458: `pas login` writes config.session (the obsolete config.github this
  // used to check is never set any more), so verify the session the same way
  // `pas publish` does — against /v1/auth/me — rather than trusting a stale field.
  const token = resolveToken();
  if (!token) {
    process.stdout.write('Not signed in. Run `pas login` first.\n');
    process.exit(1);
  }

  let res: Response;
  try {
    res = await fetch(`${config.authApiBase}/v1/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (e) {
    process.stderr.write(`Network error: ${e}\n`);
    process.exit(1);
  }

  if (!res.ok) {
    process.stdout.write('Not signed in (session expired or invalid). Run `pas login` again.\n');
    process.exit(1);
  }

  const me = (await res.json()) as { login?: string; name?: string; id?: string };
  process.stdout.write(`@${me.login ?? me.name ?? me.id ?? 'unknown'}\n`);
}

export const whoamiCommand = new Command('whoami')
  .description('Show the currently signed-in user.')
  .action(runWhoami);
