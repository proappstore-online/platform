import { Command } from 'commander';
import { ownerApi, requireSession, resolveAppIdOrExit } from './secret.js';

// `pas schedule` (#261): scheduled action and worker-schedule runs (#123, #255).

interface Run {
  run_id: string;
  action_name: string;
  due_at: number;
  finished_at: number | null;
  status: string;
  changes: number | null;
  error: string | null;
}

const RUN_STATUSES = ['due', 'claimed', 'succeeded', 'failed'];
const WORKER_RUN_PREFIX = 'worker:';

export const scheduleCommand = new Command('schedule')
  .description('Scheduled runs: history, and running a worker schedule now.')
  .addCommand(
    new Command('runs')
      .description('Recent scheduled-action and worker-schedule runs, newest first.')
      .option('--status <status>', `only ${RUN_STATUSES.join(' | ')}`)
      .option('--limit <n>', 'how many (max 200)', '50')
      .option('--app <id>', 'app id (defaults to package.json name in cwd)')
      .option('--json', 'Output JSON.')
      .action(async (opts: { status?: string; limit: string; app?: string; json?: boolean }) => {
        if (opts.status && !RUN_STATUSES.includes(opts.status)) {
          process.stderr.write(`pas: --status must be one of ${RUN_STATUSES.join(', ')}\n`);
          process.exit(1);
        }
        const cfg = await requireSession();
        const appId = await resolveAppIdOrExit(opts.app);
        const q = new URLSearchParams({ limit: opts.limit, ...(opts.status ? { status: opts.status } : {}) });
        const { runs } = await ownerApi<{ runs: Run[] }>(cfg, 'GET', `/v1/apps/${appId}/scheduled-runs?${q}`, 'list runs');
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(runs, null, 2)}\n`);
          return;
        }
        if (runs.length === 0) {
          process.stdout.write(`No ${opts.status ? `${opts.status} ` : ''}runs for ${appId}.\n`);
          return;
        }
        for (const r of runs) {
          const what = r.action_name.startsWith(WORKER_RUN_PREFIX) ? `worker ${r.action_name.slice(WORKER_RUN_PREFIX.length)}` : `action ${r.action_name}`;
          // due/claimed/queued have not finished: shown as in progress.
          const status = r.status === 'succeeded' || r.status === 'failed' ? r.status : `in progress (${r.status})`;
          process.stdout.write(`${new Date(r.due_at).toISOString()}  ${what.padEnd(32)} ${status}${r.error ? `\n  ${r.error}` : ''}\n`);
        }
      }),
  )
  .addCommand(
    new Command('run')
      .description('Run a worker schedule now: the next platform tick (≤ 5 min) starts it.')
      .argument('<name>', 'worker schedule name from mcp.json worker.schedules')
      .option('--app <id>', 'app id (defaults to package.json name in cwd)')
      .action(async (name: string, opts: { app?: string }) => {
        const cfg = await requireSession();
        const appId = await resolveAppIdOrExit(opts.app);
        const r = await ownerApi<{ run_id: string }>(cfg, 'POST', `/v1/apps/${appId}/worker/schedules/${encodeURIComponent(name)}/run`, `run ${name}`);
        process.stdout.write(`✓ queued ${name} (run ${r.run_id}); it starts on the next platform tick. Follow it: pas schedule runs\n`);
      }),
  );
