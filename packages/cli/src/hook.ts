import { Command } from 'commander';
import { ownerApi, requireSession, resolveAppIdOrExit } from './secret.js';

// `pas hook` (#261): inbound webhooks (#256), owner-authenticated.

interface Hook {
  name: string;
  url: string | null;
  verify_kind: string;
  secret_name: string | null;
  secret_set: boolean | null;
  to: 'worker' | { action: string };
}

interface Delivery {
  id: string;
  hook: string;
  delivery_id: string;
  event: string | null;
  received_at: number;
  status: string;
  attempts: number;
  finished_at: number | null;
  error: string | null;
}

const DELIVERY_STATUSES = ['received', 'delivered', 'failed', 'quota_exceeded'];

export const hookCommand = new Command('hook')
  .description('Inspect inbound webhooks (list, deliveries).')
  .addCommand(
    new Command('list')
      .alias('ls')
      .description('Registered hooks: public URL, verifier and whether its secret is set.')
      .option('--app <id>', 'app id (defaults to package.json name in cwd)')
      .option('--json', 'Output JSON.')
      .action(async (opts: { app?: string; json?: boolean }) => {
        const cfg = await requireSession();
        const appId = await resolveAppIdOrExit(opts.app);
        const { hooks } = await ownerApi<{ hooks: Hook[] }>(cfg, 'GET', `/v1/apps/${appId}/hooks`, 'list hooks');
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(hooks, null, 2)}\n`);
          return;
        }
        if (hooks.length === 0) {
          process.stdout.write(`No hooks for ${appId}. Declare them under "hooks" in mcp.json.\n`);
          return;
        }
        for (const h of hooks) {
          const secret = h.secret_name ? `${h.secret_name} ${h.secret_set ? 'set' : 'MISSING — pas secret set ' + h.secret_name}` : 'no secret';
          const to = h.to === 'worker' ? 'worker' : `action ${h.to.action}`;
          process.stdout.write(`${h.name.padEnd(20)} ${h.verify_kind.padEnd(20)} → ${to}\n  ${h.url ?? '(fed by the platform GitHub App)'}\n  secret: ${secret}\n`);
        }
      }),
  )
  .addCommand(
    new Command('deliveries')
      .description('Recent deliveries of one hook, newest first (never the body).')
      .argument('<name>', 'hook name')
      .option('--status <status>', `only ${DELIVERY_STATUSES.join(' | ')}`)
      .option('--limit <n>', 'how many (max 200)', '50')
      .option('--app <id>', 'app id (defaults to package.json name in cwd)')
      .option('--json', 'Output JSON.')
      .action(async (name: string, opts: { status?: string; limit: string; app?: string; json?: boolean }) => {
        if (opts.status && !DELIVERY_STATUSES.includes(opts.status)) {
          process.stderr.write(`pas: --status must be one of ${DELIVERY_STATUSES.join(', ')}\n`);
          process.exit(1);
        }
        const cfg = await requireSession();
        const appId = await resolveAppIdOrExit(opts.app);
        const q = new URLSearchParams({ hook: name, limit: opts.limit, ...(opts.status ? { status: opts.status } : {}) });
        const { deliveries } = await ownerApi<{ deliveries: Delivery[] }>(cfg, 'GET', `/v1/apps/${appId}/hook-deliveries?${q}`, 'list deliveries');
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(deliveries, null, 2)}\n`);
          return;
        }
        if (deliveries.length === 0) {
          process.stdout.write(`No ${opts.status ? `${opts.status} ` : ''}deliveries for ${name}.\n`);
          return;
        }
        for (const d of deliveries) {
          process.stdout.write(
            `${new Date(d.received_at).toISOString()}  ${d.status.padEnd(14)} attempts ${d.attempts}  ${d.delivery_id}${d.event ? ` (${d.event})` : ''}${d.error ? `\n  ${d.error}` : ''}\n`,
          );
        }
      }),
  );
