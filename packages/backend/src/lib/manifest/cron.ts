import { SCHEDULER_TICK_MINUTES } from '../scheduler-tick.js';

/**
 * The scheduler understands numeric five-field UTC cron only. Keeping the
 * grammar deliberately compact means the validation and executor cannot drift:
 * wildcard, lists, ranges and steps are enough for normal maintenance jobs.
 */
const CRON_FIELD_LIMITS: ReadonlyArray<readonly [number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];

function cronFieldValues(raw: string, min: number, max: number): number[] | null {
  const values = new Set<number>();
  for (const part of raw.split(',')) {
    if (!part) return null;
    const pieces = part.split('/');
    const [base, stepText] = pieces;
    if (pieces.length > 2 || !base) return null;
    // Digits only: Number() would otherwise read "1e1", "0x5" and "5.0" as steps.
    if (stepText !== undefined && !/^\d+$/.test(stepText)) return null;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (step < 1 || step > max - min + 1) return null;
    let start: number;
    let end: number;
    if (base === '*') { start = min; end = max; }
    else if (/^\d+$/.test(base)) {
      // Standard cron: a bare start before a step ("5/15") means start..max.
      start = Number(base);
      end = stepText === undefined ? start : max;
    } else {
      const match = /^(\d+)-(\d+)$/.exec(base);
      if (!match) return null;
      start = Number(match[1]); end = Number(match[2]);
    }
    if (start < min || end > max || start > end) return null;
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return [...values].sort((a, b) => a - b);
}

const CRON_MINUTES_NOT_ON_TICK = `minutes must be multiples of ${SCHEDULER_TICK_MINUTES} (the platform ticks every ${SCHEDULER_TICK_MINUTES} minutes)`;
const CRON_DATE_NEVER_OCCURS = 'never fires: no listed day-of-month occurs in any listed month';

/** Longest each month (1-12) can be; February counts its leap-year 29th. */
const MONTH_MAX_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/** Errors that are a malformed cron rather than a well-formed one that would never fire. */
const CRON_SYNTAX_ERRORS = new Set(['must have five fields', 'has an invalid field']);

/**
 * Why a scheduled-action cron is invalid, or null when it is valid: five numeric
 * fields, (#281) every minute a multiple of {@link SCHEDULER_TICK_MINUTES}, and a
 * day-of-month/month combination that can occur. The scheduler only ever runs on
 * the tick and matches the minute exactly ({@link scheduledCronMatches}), so a
 * minute like :07 would be accepted and then never fire — reject it here, where
 * the owner sees the error. On-tick minutes are at least one tick apart, so this
 * also enforces the minimum interval. Likewise "0 0 31 2 *" (February 31st) is
 * well-formed but never matches; when day-of-week is restricted too, the OR rule
 * still lets it fire on that weekday, so only a `*` day-of-week is rejected.
 */
export function scheduledCronError(cron: string): string | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return 'must have five fields';
  const values = fields.map((field, i) => cronFieldValues(field, CRON_FIELD_LIMITS[i]![0], CRON_FIELD_LIMITS[i]![1]));
  if (values.some((v) => v === null)) return 'has an invalid field';
  if (values[0]!.some((m) => m % SCHEDULER_TICK_MINUTES !== 0)) return CRON_MINUTES_NOT_ON_TICK;
  if (fields[2] !== '*' && fields[4] === '*') {
    const longestMonth = Math.max(...values[3]!.map((month) => MONTH_MAX_DAYS[month - 1]!));
    if (values[2]![0]! > longestMonth) return CRON_DATE_NEVER_OCCURS;
  }
  return null;
}

/** Is this a malformed cron (as opposed to a well-formed one that would never fire)? */
export function isCronSyntaxError(error: string): boolean {
  return CRON_SYNTAX_ERRORS.has(error);
}

/** Does this validated five-field cron match a UTC minute? DOM/DOW follow the
 * conventional cron OR rule when both fields are restricted. */
export function scheduledCronMatches(cron: string, timestamp: number): boolean {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const values = fields.map((field, i) => cronFieldValues(field, CRON_FIELD_LIMITS[i]![0], CRON_FIELD_LIMITS[i]![1]));
  if (values.some((v) => v === null)) return false;
  const date = new Date(timestamp);
  const minute = date.getUTCMinutes();
  const hour = date.getUTCHours();
  const day = date.getUTCDate();
  const month = date.getUTCMonth() + 1;
  const weekday = date.getUTCDay();
  if (!values[0]!.includes(minute) || !values[1]!.includes(hour) || !values[3]!.includes(month)) return false;
  const domRestricted = fields[2] !== '*';
  const dowRestricted = fields[4] !== '*';
  const dom = values[2]!.includes(day);
  const dow = values[4]!.includes(weekday);
  return domRestricted && dowRestricted ? dom || dow : dom && dow;
}
