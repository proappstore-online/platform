import { Command } from 'commander';
import { type CliConfig } from './lib/config.js';
import { ownerApi, requireSession, resolveAppIdOrExit } from './secret.js';

// `pas worker` (#261): the app worker's state (ADR-009), owner-authenticated.

interface Invocation {
  id: string;
  type: string;
  name: string | null;
  attempt: number;
  status: string;
  http_status: number | null;
  started_at: number;
  finished_at: number | null;
  error: string | null;
}

interface WorkerStatus {
  worker: {
    enabled: number;
    backend?: string | null;
    bundle_sha256?: string | null;
    deployed_sha?: string | null;
    deployed_ref?: string | null;
    deployed_at?: number | null;
    rotation_overlap_until?: number | null;
  };
  last_deploy: { sha: string | null; ref: string | null; status: string; detail: string | null; created_at: number } | null;
  invocations: Invocation[];
  schedules: { name: string; cron: string; consecutive_failures: number | null; schedule_disabled_at: number | null }[];
}

interface Usage {
  quotas: { invocations: number; cpu_ms: number; hook_deliveries: number };
  cpu_ms_source: string;
  today: { day: string; invocations: number; cpu_ms: number; hook_deliveries: number; pas_calls: number };
}

interface LogEntry { ts: number; level: string; message: string; data?: unknown }

const iso = (ms: number) => new Date(ms).toISOString();

/** `30s`, `10m`, `1h`, `2d` → milliseconds. */
export function parseSince(raw: string): number {
  const m = /^(\d+)([smhd])$/.exec(raw.trim());
  if (!m) throw new Error(`--since must look like 30s, 10m, 1h or 2d (got "${raw}")`);
  return Number(m[1]) * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 's' | 'm' | 'h' | 'd'];
}

/**
 * The worker's `PAS.log` lines and its invocation outcomes after `since`, oldest
 * first, as printable lines keyed for de-duplication across polls.
 */
export async function workerLogLines(cfg: CliConfig, appId: string, since: number): Promise<{ key: string; ts: number; line: string }[]> {
  const [{ logs }, status] = await Promise.all([
    ownerApi<{ logs: LogEntry[] }>(cfg, 'GET', `/v1/apps/${appId}/logs?category=worker&since=${since}&limit=500`, 'read worker logs'),
    ownerApi<WorkerStatus>(cfg, 'GET', `/v1/apps/${appId}/worker`, 'read worker status'),
  ]);
  const lines = logs.map((l) => ({
    key: `log:${l.ts}:${l.message}`,
    ts: l.ts,
    line: `${iso(l.ts)}  ${l.level.padEnd(5)}  ${l.message}${l.data == null ? '' : ` ${JSON.stringify(l.data)}`}`,
  }));
  for (const inv of status.invocations) {
    // A running invocation is printed once it finishes.
    if (inv.finished_at == null || inv.finished_at < since) continue;
    const what = `${inv.type}${inv.name ? ` ${inv.name}` : ''} attempt ${inv.attempt}`;
    const outcome = `${inv.status}${inv.http_status ? ` (${inv.http_status})` : ''}${inv.error ? `: ${inv.error}` : ''}`;
    lines.push({ key: `run:${inv.id}`, ts: inv.finished_at, line: `${iso(inv.finished_at)}  run    ${what} ${outcome}` });
  }
  return lines.sort((a, b) => a.ts - b.ts);
}

const FOLLOW_INTERVAL_MS = 5_000;

export const workerCommand = new Command('worker')
  .description('Inspect and manage the app worker (status, logs, key rotation).')
  .addCommand(
    new Command('status')
      .description('Enabled flag, last deploy, schedules and recent invocations.')
      .option('--app <id>', 'app id (defaults to package.json name in cwd)')
      .option('--json', 'Output JSON.')
      .action(async (opts: { app?: string; json?: boolean }) => {
        const cfg = await requireSession();
        const appId = await resolveAppIdOrExit(opts.app);
        const [s, usage] = await Promise.all([
          ownerApi<WorkerStatus>(cfg, 'GET', `/v1/apps/${appId}/worker`, 'read worker status'),
          ownerApi<Usage>(cfg, 'GET', `/v1/apps/${appId}/worker/usage?days=1`, 'read worker usage'),
        ]);
        if (opts.json) {
          process.stdout.write(`${JSON.stringify({ ...s, usage }, null, 2)}\n`);
          return;
        }
        const w = s.worker;
        const out: string[] = [`${appId}: app worker ${w.enabled ? 'enabled' : 'not enabled (a platform admin enables it)'}`];
        if (w.backend) out.push(`  backend   ${w.backend}`);
        if (w.deployed_at) out.push(`  deployed  ${w.deployed_sha?.slice(0, 12) ?? '?'} (${w.deployed_ref ?? '?'}) at ${iso(w.deployed_at)}`);
        if (s.last_deploy) out.push(`  last deploy ${s.last_deploy.status} at ${iso(s.last_deploy.created_at)}${s.last_deploy.detail ? ` — ${s.last_deploy.detail}` : ''}`);
        if (w.rotation_overlap_until && w.rotation_overlap_until > Date.now()) out.push(`  key rotation overlap until ${iso(w.rotation_overlap_until)}`);
        const t = usage.today;
        const q = usage.quotas;
        out.push(`  today (${t.day} UTC)  invocations ${t.invocations}/${q.invocations} · ${usage.cpu_ms_source === 'wall' ? 'wall-clock' : 'cpu'} ms ${t.cpu_ms}/${q.cpu_ms} · hook deliveries ${t.hook_deliveries}/${q.hook_deliveries} · PAS calls ${t.pas_calls}`);
        if (s.schedules.length) {
          out.push('  schedules');
          for (const sch of s.schedules) {
            const state = sch.schedule_disabled_at ? `DISABLED after ${sch.consecutive_failures} failures — redeploy mcp.json to re-enable` : 'active';
            out.push(`    ${sch.name.padEnd(24)} ${sch.cron.padEnd(16)} ${state}`);
          }
        }
        if (s.invocations.length) {
          out.push('  recent invocations');
          for (const inv of s.invocations) {
            out.push(`    ${iso(inv.started_at)}  ${`${inv.type}${inv.name ? ` ${inv.name}` : ''}`.padEnd(24)} ${inv.status}${inv.error ? `: ${inv.error}` : ''}`);
          }
        }
        process.stdout.write(`${out.join('\n')}\n`);
      }),
  )
  .addCommand(
    new Command('logs')
      .description("The worker's PAS.log lines and invocation outcomes.")
      .option('--since <window>', 'how far back: 30s, 10m, 1h, 2d', '1h')
      .option('-f, --follow', `keep polling every ${FOLLOW_INTERVAL_MS / 1000} s`)
      .option('--app <id>', 'app id (defaults to package.json name in cwd)')
      .action(async (opts: { since: string; follow?: boolean; app?: string }) => {
        const cfg = await requireSession();
        const appId = await resolveAppIdOrExit(opts.app);
        let since = Date.now() - parseSince(opts.since);
        const seen = new Set<string>();
        for (;;) {
          for (const l of await workerLogLines(cfg, appId, since)) {
            if (seen.has(l.key)) continue;
            seen.add(l.key);
            since = Math.max(since, l.ts);
            process.stdout.write(`${l.line}\n`);
          }
          if (!opts.follow) return;
          await new Promise((r) => setTimeout(r, FOLLOW_INTERVAL_MS));
        }
      }),
  )
  .addCommand(
    new Command('rotate')
      .description('Rotate the worker token and event key (the old pair keeps working for a short overlap).')
      .option('--app <id>', 'app id (defaults to package.json name in cwd)')
      .action(async (opts: { app?: string }) => {
        const cfg = await requireSession();
        const appId = await resolveAppIdOrExit(opts.app);
        const r = await ownerApi<{ config_version: number }>(cfg, 'POST', `/v1/apps/${appId}/worker/rotate`, 'rotate worker keys');
        process.stdout.write(`✓ rotated worker keys for ${appId} (config version ${r.config_version})\n`);
      }),
  );
