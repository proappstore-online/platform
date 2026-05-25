import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Command } from 'commander';
import { type CliConfig, readConfig } from './lib/config.js';

interface SecretSummary {
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export const secretCommand = new Command('secret')
  .description('Manage server-side API keys for an app (set/list/rm).')
  .addCommand(
    new Command('set')
      .description('Store or replace an encrypted API key for an app.')
      .argument('<name>', 'secret name (uppercase + underscores, e.g. AMADEUS_CLIENT_ID)')
      .argument('<value>', 'plaintext value to encrypt and store')
      .option('--app <id>', 'app id (defaults to package.json name in cwd)')
      .action(async (name: string, value: string, opts: { app?: string }) => {
        const cfg = await requireSession();
        const appId = await resolveAppIdOrExit(opts.app);
        const res = await fetch(`${cfg.apiBase}/v1/apps/${appId}/secrets/${name}`, {
          method: 'PUT',
          headers: bearer(cfg),
          body: JSON.stringify({ value }),
        });
        if (!res.ok) await dieFromHttp(res, `set ${name}`);
        process.stdout.write(`✓ stored ${name} for ${appId}\n`);
      }),
  )
  .addCommand(
    new Command('list')
      .alias('ls')
      .description('List secret names registered for an app (values are never returned).')
      .option('--app <id>', 'app id (defaults to package.json name in cwd)')
      .option('--json', 'Output JSON.')
      .action(async (opts: { app?: string; json?: boolean }) => {
        const cfg = await requireSession();
        const appId = await resolveAppIdOrExit(opts.app);
        const res = await fetch(`${cfg.apiBase}/v1/apps/${appId}/secrets`, {
          headers: bearer(cfg),
        });
        if (!res.ok) await dieFromHttp(res, 'list secrets');
        const { secrets } = (await res.json()) as { secrets: SecretSummary[] };
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(secrets, null, 2)}\n`);
          return;
        }
        if (secrets.length === 0) {
          process.stdout.write(`No secrets for ${appId}.\n`);
          return;
        }
        for (const s of secrets) {
          const last = s.lastUsedAt ? new Date(s.lastUsedAt).toISOString() : 'never';
          process.stdout.write(`${s.name.padEnd(32)} last used: ${last}\n`);
        }
      }),
  )
  .addCommand(
    new Command('rm')
      .alias('remove')
      .description('Delete a stored secret.')
      .argument('<name>', 'secret name')
      .option('--app <id>', 'app id (defaults to package.json name in cwd)')
      .action(async (name: string, opts: { app?: string }) => {
        const cfg = await requireSession();
        const appId = await resolveAppIdOrExit(opts.app);
        const res = await fetch(`${cfg.apiBase}/v1/apps/${appId}/secrets/${name}`, {
          method: 'DELETE',
          headers: bearer(cfg),
        });
        if (!res.ok) await dieFromHttp(res, `rm ${name}`);
        process.stdout.write(`✓ removed ${name} from ${appId}\n`);
      }),
  );

// Shared helpers (also used by proxy.ts)

export async function requireSession(): Promise<CliConfig> {
  const cfg = await readConfig();
  if (!cfg.session?.token) {
    process.stdout.write('\n⚠  Not signed in. Run: pas login\n');
    process.exit(1);
  }
  return cfg;
}

export function bearer(cfg: CliConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${cfg.session!.token}`,
    'Content-Type': 'application/json',
  };
}

export async function resolveAppIdOrExit(explicit: string | undefined): Promise<string> {
  if (explicit) {
    if (!/^[a-z][a-z0-9-]*$/.test(explicit) || explicit.length > 58) {
      process.stderr.write(`pas: invalid app id "${explicit}".\n`);
      process.exit(1);
    }
    return explicit;
  }
  try {
    const raw = await readFile(join(process.cwd(), 'package.json'), 'utf8');
    const name = (JSON.parse(raw) as { name?: string }).name;
    if (name && /^[a-z][a-z0-9-]*$/.test(name)) return name;
  } catch {}
  process.stderr.write(
    'pas: no app id. Pass --app <id> or run from a directory whose package.json `name` is the app id.\n',
  );
  process.exit(1);
}

export async function dieFromHttp(res: Response, action: string): Promise<never> {
  const text = await res.text();
  let msg = text;
  try {
    const parsed = JSON.parse(text) as { error?: string };
    if (parsed.error) msg = parsed.error;
  } catch {}
  process.stderr.write(`pas: ${action} failed (${res.status}): ${msg}\n`);
  process.exit(1);
}
