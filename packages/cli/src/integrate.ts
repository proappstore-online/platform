import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { bearer, dieFromHttp, requireSession, resolveAppIdOrExit } from './secret.js';

type InjectKind = 'query' | 'header' | 'bearer' | 'oauth2_cc';

interface Integration {
  name: string;
  auth: string;
  headerName?: string;
  queryParam?: string;
  tokenUrl?: string;
  patterns: string[];
  methods: string[];
  secrets: string[];
  docs: string;
  note?: string;
}

// Load catalog at runtime from the file shipped alongside the compiled JS.
const __dirname = dirname(fileURLToPath(import.meta.url));
const catalogPath = join(__dirname, 'integrations.json');
const integrations = JSON.parse(readFileSync(catalogPath, 'utf8')) as Record<string, Integration>;

export const integrateCommand = new Command('integrate')
  .description('Connect a third-party API using pre-configured proxy rules.')
  .argument('[name]', `integration name (run "pas integrate list" to see all)`)
  .option('--app <id>', 'app id (defaults to package.json name in cwd)')
  .action(async (name: string | undefined, opts: { app?: string }) => {
    if (!name || name === 'list') {
      process.stdout.write('\nAvailable integrations:\n\n');
      for (const [id, int] of Object.entries(integrations)) {
        process.stdout.write(`  ${id.padEnd(20)} ${int.name}\n`);
      }
      process.stdout.write(`\nUsage: pas integrate <name> --app <id>\n`);
      process.stdout.write(`Then follow the prompts to enter your API credentials.\n\n`);
      return;
    }

    const integration = integrations[name];
    if (!integration) {
      process.stderr.write(`pas: unknown integration "${name}".\n`);
      process.stderr.write(`Available: ${Object.keys(integrations).join(', ')}\n`);
      process.stderr.write(`Run: pas integrate list\n`);
      process.exit(1);
    }

    const cfg = await requireSession();
    const appId = await resolveAppIdOrExit(opts.app);
    const prefix = name.toUpperCase().replace(/-/g, '_');

    process.stdout.write(`\n  Integrating ${integration.name} for ${appId}\n`);
    process.stdout.write(`  Docs: ${integration.docs}\n\n`);

    if (integration.note) {
      process.stdout.write(`  Note: ${integration.note}\n\n`);
    }

    // Collect secrets interactively
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const secretValues: Record<string, string> = {};
    try {
      for (const secretSuffix of integration.secrets) {
        const secretName = `${prefix}_${secretSuffix}`;
        const value = await rl.question(`  ${secretName}: `);
        if (!value.trim()) {
          process.stderr.write(`\n  Aborted — ${secretName} is required.\n`);
          process.stderr.write(`  Get yours at: ${integration.docs}\n\n`);
          process.exit(1);
        }
        secretValues[secretName] = value.trim();
      }
    } finally {
      rl.close();
    }

    // Store secrets
    for (const [secretName, value] of Object.entries(secretValues)) {
      const res = await fetch(`${cfg.apiBase}/v1/apps/${appId}/secrets/${secretName}`, {
        method: 'PUT',
        headers: bearer(cfg),
        body: JSON.stringify({ value }),
      });
      if (!res.ok) await dieFromHttp(res, `store ${secretName}`);
      process.stdout.write(`  [+] Stored ${secretName}\n`);
    }

    // Create proxy allowlist rules
    if (integration.patterns.length === 0) {
      process.stdout.write(`\n  Secrets stored. Add proxy rules for your specific API hosts:\n`);
      process.stdout.write(`    pas proxy allow 'https://<host>/' --inject ${mapAuth(integration)} --secret ${prefix}_${integration.secrets[0]} --app ${appId}\n\n`);
      return;
    }

    const secretNames = Object.keys(secretValues);
    for (const pattern of integration.patterns) {
      const body: Record<string, unknown> = {
        pattern,
        injectKind: mapInjectKind(integration),
        injectName: mapInjectName(integration),
        secretName: secretNames[0],
        methods: integration.methods,
      };
      if (integration.auth === 'oauth2_cc' && secretNames[1]) {
        body.secretName2 = secretNames[1];
        body.tokenUrl = integration.tokenUrl;
      }

      const res = await fetch(`${cfg.apiBase}/v1/apps/${appId}/allowlist`, {
        method: 'PUT',
        headers: bearer(cfg),
        body: JSON.stringify(body),
      });
      if (!res.ok) await dieFromHttp(res, `add rule for ${pattern}`);
      process.stdout.write(`  [+] Proxy rule: ${pattern}\n`);
    }

    const exampleHost = new URL(integration.patterns[0]!).host;
    const examplePath = new URL(integration.patterns[0]!).pathname;
    process.stdout.write(`\n  Done! Use in your app:\n`);
    process.stdout.write(`    const res = await app.proxy.fetch('${exampleHost}${examplePath}...')\n\n`);
  });

function mapInjectKind(int: Integration): InjectKind {
  switch (int.auth) {
    case 'bearer': return 'bearer';
    case 'header': return 'header';
    case 'query': return 'query';
    case 'oauth2_cc': return 'oauth2_cc';
    default: return 'bearer';
  }
}

function mapInjectName(int: Integration): string {
  if (int.auth === 'header') return int.headerName ?? 'X-API-Key';
  if (int.auth === 'query') return int.queryParam ?? 'key';
  return '';
}

function mapAuth(int: Integration): string {
  if (int.auth === 'header') return `header:${int.headerName ?? 'X-API-Key'}`;
  if (int.auth === 'query') return `query:${int.queryParam ?? 'key'}`;
  return int.auth;
}
