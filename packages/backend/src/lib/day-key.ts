/** The UTC day key, YYYY-MM-DD, of `now` (default: the current time). Matches the `day` column convention. */
export function utcDayKey(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}
