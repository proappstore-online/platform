/** Today's UTC day key, YYYY-MM-DD. */
export function utcDayKey(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}
