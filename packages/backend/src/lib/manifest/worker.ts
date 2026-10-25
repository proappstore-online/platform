import { MAX_SECRETS_PER_APP, SECRET_NAME_RE } from '../../routes/secrets-shared.js';
import { isCronSyntaxError, scheduledCronError } from './cron.js';

/** The `worker` section (#254): `{ secrets?: string[] }` naming app secrets (app_secrets.name). */
/** ADR-009 §4: worker schedules per app, separate from (and fewer than) action schedules — worker runs are heavier. */
const MAX_WORKER_SCHEDULES_PER_APP = 3;
const MAX_WORKER_SCHEDULE_PARAMS_BYTES = 4096;
const WORKER_SCHEDULE_NAME = /^[a-z][a-z0-9_]{0,49}$/;

interface WorkerSchedule { name: string; cron: string; params: Record<string, unknown> }
export interface WorkerManifest { secrets: string[]; schedules: WorkerSchedule[] }

/**
 * The `worker` section: `{ secrets?: string[], schedules?: [{ name, cron, params? }] }`.
 * Secrets name app secrets (#254); schedules run the app worker on the platform
 * tick (#255) — same cron rules as scheduled actions, minutes on the 5-minute tick.
 */
export function validateWorkerManifest(worker: unknown): { error: string } | { worker: WorkerManifest | null } {
  if (worker === undefined || worker === null) return { worker: null };
  if (typeof worker !== 'object' || Array.isArray(worker)) return { error: 'worker must be an object' };
  const extra = Object.keys(worker).find((k) => k !== 'secrets' && k !== 'schedules');
  if (extra) return { error: `worker: unknown field "${extra}"` };
  const secrets = (worker as { secrets?: unknown }).secrets ?? [];
  if (!Array.isArray(secrets) || secrets.length > MAX_SECRETS_PER_APP || secrets.some((n) => typeof n !== 'string' || !SECRET_NAME_RE.test(n))) {
    return { error: `worker.secrets must be an array of at most ${MAX_SECRETS_PER_APP} app secret names (${SECRET_NAME_RE.source})` };
  }
  if (new Set(secrets).size !== secrets.length) return { error: 'worker.secrets must not repeat a name' };

  const rawSchedules = (worker as { schedules?: unknown }).schedules ?? [];
  if (!Array.isArray(rawSchedules) || rawSchedules.length > MAX_WORKER_SCHEDULES_PER_APP) {
    return { error: `worker.schedules must be an array of at most ${MAX_WORKER_SCHEDULES_PER_APP} schedules` };
  }
  const schedules: WorkerSchedule[] = [];
  for (const [i, raw] of rawSchedules.entries()) {
    const at = `worker.schedules[${i}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: `${at} must be an object` };
    const unknown = Object.keys(raw).find((k) => !['name', 'cron', 'params'].includes(k));
    if (unknown) return { error: `${at}: unknown field "${unknown}"` };
    const { name, cron, params = {} } = raw as { name?: unknown; cron?: unknown; params?: unknown };
    if (typeof name !== 'string' || !WORKER_SCHEDULE_NAME.test(name)) return { error: `${at}.name must match ${WORKER_SCHEDULE_NAME.source}` };
    if (schedules.some((s) => s.name === name)) return { error: `${at}: duplicate name "${name}"` };
    if (typeof cron !== 'string') return { error: `${at}.cron must be a five-field numeric UTC cron string` };
    const cronError = scheduledCronError(cron);
    if (cronError) return { error: isCronSyntaxError(cronError) ? `${at}.cron must be a valid five-field numeric UTC cron` : `${at}.cron ${cronError}` };
    if (!params || typeof params !== 'object' || Array.isArray(params)) return { error: `${at}.params must be an object` };
    if (new TextEncoder().encode(JSON.stringify(params)).byteLength > MAX_WORKER_SCHEDULE_PARAMS_BYTES) {
      return { error: `${at}.params must be at most ${MAX_WORKER_SCHEDULE_PARAMS_BYTES} bytes of JSON` };
    }
    schedules.push({ name, cron, params: params as Record<string, unknown> });
  }
  return { worker: { secrets: secrets as string[], schedules } };
}
