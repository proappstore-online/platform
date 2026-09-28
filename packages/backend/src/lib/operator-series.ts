/**
 * Metric time series for the operator console (#240): validating a requested
 * range and grain against a resource's declared `series`, and rolling the
 * app's query rows up into grain buckets. Pure — the metrics route runs the
 * query; nothing here stores or logs a value.
 *
 * Dates are UTC calendar days (YYYY-MM-DD). A week starts on Monday; a month on
 * its 1st. A bucket with no rows is null, never 0, so "no data" and "zero" stay
 * distinguishable for every aggregation.
 */
import { HttpError } from './auth.js';
import { SERIES_GRAINS, type OperatorSeries, type SeriesGrain } from './operator-contract-series.js';

const DAY = 86_400_000;

export interface SeriesRequest { from: string; to: string; grain: SeriesGrain }

interface Acc { sum: number; count: number; min: number; max: number; abs: number }

/** A strict YYYY-MM-DD calendar date as UTC ms, or null. */
function parseDay(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && dayKey(ms) === value ? ms : null;
}

const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function bucketStart(ms: number, grain: SeriesGrain): number {
  const d = new Date(ms);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (grain === 'day') return day;
  if (grain === 'week') return day - ((d.getUTCDay() + 6) % 7) * DAY;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function nextBucket(ms: number, grain: SeriesGrain): number {
  if (grain === 'day') return ms + DAY;
  if (grain === 'week') return ms + 7 * DAY;
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/**
 * The requested range and grain, or a 400. Defaults: to = today, from =
 * default_days back, grain = the declared one. A grain finer than the
 * declared one cannot be derived from its rows and is refused.
 */
export function resolveSeriesRequest(
  series: OperatorSeries,
  query: { from?: string | undefined; to?: string | undefined; grain?: string | undefined },
  now = Date.now(),
): SeriesRequest {
  const today = bucketStart(now, 'day');
  const toMs = query.to ? parseDay(query.to) : today;
  if (toMs === null) throw new HttpError('to must be a date (YYYY-MM-DD)', 400);
  const fromMs = query.from ? parseDay(query.from) : toMs - (series.range.default_days - 1) * DAY;
  if (fromMs === null) throw new HttpError('from must be a date (YYYY-MM-DD)', 400);
  if (fromMs > toMs) throw new HttpError('from must not be after to', 400);
  if (toMs > today) throw new HttpError('to must not be in the future', 400);
  const days = (toMs - fromMs) / DAY + 1;
  if (days > series.range.max_days) throw new HttpError(`range is ${days} days; this metric allows at most ${series.range.max_days}`, 400);
  const grain = (query.grain ?? series.time.grain) as SeriesGrain;
  if (!SERIES_GRAINS.includes(grain)) throw new HttpError(`grain must be one of ${SERIES_GRAINS.join(', ')}`, 400);
  if (SERIES_GRAINS.indexOf(grain) < SERIES_GRAINS.indexOf(series.time.grain)) {
    throw new HttpError(`grain must be ${series.time.grain} or coarser`, 400);
  }
  return { from: dayKey(fromMs), to: dayKey(toMs), grain };
}

/** A row's time as UTC ms: an ISO date/time string, or epoch seconds/milliseconds. */
function rowTime(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string' && value) {
    const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function add(acc: Acc | undefined, v: number): Acc {
  if (!acc) return { sum: v, count: 1, min: v, max: v, abs: Math.abs(v) };
  acc.sum += v; acc.count += 1; acc.abs += Math.abs(v);
  acc.min = Math.min(acc.min, v); acc.max = Math.max(acc.max, v);
  return acc;
}

function value(acc: Acc | undefined, aggregation: OperatorSeries['measures'][number]['aggregation']): number | null {
  if (!acc) return null;
  if (aggregation === 'sum') return acc.sum;
  if (aggregation === 'avg') return acc.sum / acc.count;
  return aggregation === 'min' ? acc.min : acc.max;
}

export function rollupSeries(series: OperatorSeries, rows: Record<string, unknown>[], req: SeriesRequest) {
  // req comes from resolveSeriesRequest, so both dates parse.
  const fromMs = parseDay(req.from) ?? 0;
  const endMs = (parseDay(req.to) ?? 0) + DAY; // exclusive
  const buckets: string[] = [];
  const index = new Map<number, number>();
  for (let b = bucketStart(fromMs, req.grain); b < endMs; b = nextBucket(b, req.grain)) {
    index.set(b, buckets.length);
    buckets.push(dayKey(b));
  }

  // per dimension value (null without a breakdown) → per measure → per bucket, plus a whole-range total.
  const groups = new Map<string | null, { buckets: (Acc | undefined)[][]; total: (Acc | undefined)[] }>();
  const overall: (Acc | undefined)[] = series.measures.map(() => undefined);
  for (const row of rows) {
    const t = rowTime(row[series.time.column]);
    if (t === null || t < fromMs || t >= endMs) continue;
    const i = index.get(bucketStart(t, req.grain));
    if (i === undefined) continue;
    const dim = series.dimension ? String(row[series.dimension.column] ?? '(none)').slice(0, 100) : null;
    let group = groups.get(dim);
    if (!group) {
      group = { buckets: series.measures.map(() => buckets.map(() => undefined)), total: series.measures.map(() => undefined) };
      groups.set(dim, group);
    }
    const g = group;
    series.measures.forEach((m, k) => {
      const v = Number(row[m.column]);
      const cells = g.buckets[k];
      if (!cells || row[m.column] === null || row[m.column] === '' || !Number.isFinite(v)) return;
      cells[i] = add(cells[i], v);
      g.total[k] = add(g.total[k], v);
      overall[k] = add(overall[k], v);
    });
  }

  // Without a breakdown there is always exactly one series, all-null when the range is empty.
  if (!series.dimension && !groups.has(null)) groups.set(null, { buckets: series.measures.map(() => buckets.map(() => undefined)), total: series.measures.map(() => undefined) });
  // Bound the breakdown: the largest values by magnitude of the (single) measure.
  const ranked = [...groups.entries()].sort((a, b) => (b[1].total[0]?.abs ?? 0) - (a[1].total[0]?.abs ?? 0));
  const kept = series.dimension ? ranked.slice(0, series.dimension.max_values) : ranked;
  return {
    from: req.from,
    to: req.to,
    grain: req.grain,
    buckets,
    dimension: series.dimension ? { column: series.dimension.column, label: series.dimension.label } : null,
    omitted: ranked.length - kept.length,
    measures: series.measures.map((m, k) => ({
      ...m,
      summary: value(overall[k], m.aggregation),
      series: kept.map(([dim, g]) => ({
        dimension: dim,
        summary: value(g.total[k], m.aggregation),
        values: (g.buckets[k] ?? []).map((acc) => value(acc, m.aggregation)),
      })),
    })),
  };
}
