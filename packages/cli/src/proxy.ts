import { Command } from 'commander';
import { bearer, dieFromHttp, requireSession, resolveAppIdOrExit } from './secret.js';

interface AllowlistRule {
  pattern: string;
  injectKind: 'query' | 'header' | 'bearer' | 'oauth2_cc';
  injectName: string;
  secretName: string;
  secretName2?: string;
  tokenUrl?: string;
  methods: string[];
  createdAt: number;
}

export function parseInject(s: string): {
  kind: 'query' | 'header' | 'bearer' | 'oauth2_cc';
  name: string;
} {
  if (s === 'bearer') return { kind: 'bearer', name: '' };
  if (s === 'oauth2_cc') return { kind: 'oauth2_cc', name: '' };
  const m = /^(query|header):(.+)$/.exec(s);
  if (!m) {
    throw new Error(`--inject must be 'bearer', 'oauth2_cc', 'query:<name>', or 'header:<name>' (got ${s})`);
  }
  return { kind: m[1] as 'query' | 'header', name: m[2]! };
}

export const proxyCommand = new Command('proxy')
  .description('Manage the URL allowlist for the per-app secret-injecting proxy.')
  .addCommand(
    new Command('allow')
      .description('Allow the proxy to inject <secret> when calling URLs starting with <pattern>.')
      .argument('<pattern>', 'URL prefix (must start with https://)')
      .requiredOption('--secret <name>', 'name of a previously stored secret')
      .requiredOption(
        '--inject <spec>',
        "how to inject: 'query:<name>', 'header:<name>', 'bearer', or 'oauth2_cc'",
      )
      .option('--secret2 <name>', 'second secret (client_secret for oauth2_cc)')
      .option('--token-url <url>', 'OAuth2 token endpoint (required for oauth2_cc)')
      .option('--methods <list>', 'comma-separated HTTP methods', 'GET')
      .option('--app <id>', 'app id (defaults to package.json name in cwd)')
      .action(
        async (
          pattern: string,
          opts: { secret: string; secret2?: string; tokenUrl?: string; inject: string; methods: string; app?: string },
        ) => {
          const cfg = await requireSession();
          const appId = await resolveAppIdOrExit(opts.app);
          let inject;
          try {
            inject = parseInject(opts.inject);
          } catch (err) {
            process.stderr.write(`pas: ${(err as Error).message}\n`);
            process.exit(1);
          }
          const res = await fetch(`${cfg.apiBase}/v1/apps/${appId}/allowlist`, {
            method: 'PUT',
            headers: bearer(cfg),
            body: JSON.stringify({
              pattern,
              injectKind: inject.kind,
              injectName: inject.name,
              secretName: opts.secret,
              ...(opts.secret2 ? { secretName2: opts.secret2 } : {}),
              ...(opts.tokenUrl ? { tokenUrl: opts.tokenUrl } : {}),
              methods: opts.methods
                .split(',')
                .map((m) => m.trim())
                .filter(Boolean),
            }),
          });
          if (!res.ok) await dieFromHttp(res, 'add allowlist rule');
          process.stdout.write(`✓ allowed ${pattern} for ${appId}\n`);
        },
      ),
  )
  .addCommand(
    new Command('list')
      .alias('ls')
      .description('Show the proxy allowlist for an app.')
      .option('--app <id>', 'app id (defaults to package.json name in cwd)')
      .option('--json', 'Output JSON.')
      .action(async (opts: { app?: string; json?: boolean }) => {
        const cfg = await requireSession();
        const appId = await resolveAppIdOrExit(opts.app);
        const res = await fetch(`${cfg.apiBase}/v1/apps/${appId}/allowlist`, {
          headers: bearer(cfg),
        });
        if (!res.ok) await dieFromHttp(res, 'list allowlist');
        const { rules } = (await res.json()) as { rules: AllowlistRule[] };
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(rules, null, 2)}\n`);
          return;
        }
        if (rules.length === 0) {
          process.stdout.write(`No allowlist rules for ${appId}.\n`);
          return;
        }
        for (const r of rules) {
          const inject = r.injectKind === 'bearer' || r.injectKind === 'oauth2_cc'
            ? r.injectKind
            : `${r.injectKind}:${r.injectName}`;
          let line = `${r.pattern}\n  secret=${r.secretName}  inject=${inject}  methods=${r.methods.join(',')}`;
          if (r.secretName2) line += `  secret2=${r.secretName2}`;
          if (r.tokenUrl) line += `\n  token-url=${r.tokenUrl}`;
          process.stdout.write(`${line}\n`);
        }
      }),
  )
  .addCommand(
    new Command('deny')
      .alias('rm')
      .description('Remove an allowlist rule by pattern.')
      .argument('<pattern>', 'exact pattern to remove')
      .option('--app <id>', 'app id (defaults to package.json name in cwd)')
      .action(async (pattern: string, opts: { app?: string }) => {
        const cfg = await requireSession();
        const appId = await resolveAppIdOrExit(opts.app);
        const res = await fetch(`${cfg.apiBase}/v1/apps/${appId}/allowlist`, {
          method: 'DELETE',
          headers: bearer(cfg),
          body: JSON.stringify({ pattern }),
        });
        if (!res.ok) await dieFromHttp(res, 'remove allowlist rule');
        process.stdout.write(`✓ removed ${pattern} from ${appId}\n`);
      }),
  );
