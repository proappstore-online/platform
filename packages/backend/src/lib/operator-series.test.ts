import { describe, expect, it } from 'vitest';
import { resolveSeriesRequest, rollupSeries } from './operator-series.js';
import type { OperatorSeries } from './operator-contract-series.js';
import { HttpError } from './auth.js';

// #240: range/grain validation and the bucket rollup behind the operator
// metrics route. A "now" of 2026-09-28 (a Monday) keeps every date explicit.

const NOW = Date.parse('2026-09-28T15:00:00Z');
const signups: OperatorSeries = {
  time: { column: 'day', grain: 'day' },
  range: { from_param: 'from', to_param: 'to', default_days: 30, max_days: 366 },
  measures: [{ column: 'signups', label: 'Sign-ups', unit: 'count', currency: null, aggregation: 'sum' }],
  dimension: { column: 'plan', label: 'Plan', max_values: 2 },
};
const clubs: OperatorSeries = {
  time: { column: 'week_start', grain: 'week' },
  range: { from_param: 'since', to_param: 'until', default_days: 84, max_days: 366 },
  measures: [
    { column: 'attendance_rate', label: 'Attendance', unit: 'percent', currency: null, aggregation: 'avg' },
    { column: 'events', label: 'Events', unit: 'count', currency: null, aggregation: 'sum' },
    { column: 'fees', label: 'Fees', unit: 'currency', currency: 'GBP', aggregation: 'max' },
  ],
  dimension: null,
};
const refusal = (fn: () => unknown) => {
  try { fn(); } catch (e) { if (e instanceof HttpError) return [e.status, e.message] as const; throw e; }
  throw new Error('expected a refusal');
};

describe('resolveSeriesRequest', () => {
  it('defaults to the declared window ending today, at the declared grain', () => {
    expect(resolveSeriesRequest(signups, {}, NOW)).toEqual({ from: '2026-08-30', to: '2026-09-28', grain: 'day' });
    expect(resolveSeriesRequest(clubs, { to: '2026-09-27' }, NOW)).toEqual({ from: '2026-07-06', to: '2026-09-27', grain: 'week' });
    expect(resolveSeriesRequest(signups, { from: '2026-09-01', to: '2026-09-28', grain: 'month' }, NOW).grain).toBe('month');
  });

  it('refuses malformed, reversed, future and oversized ranges, and grains it cannot derive', () => {
    expect(refusal(() => resolveSeriesRequest(signups, { from: '2026-02-30' }, NOW))).toEqual([400, 'from must be a date (YYYY-MM-DD)']);
    expect(refusal(() => resolveSeriesRequest(signups, { to: 'yesterday' }, NOW))).toEqual([400, 'to must be a date (YYYY-MM-DD)']);
    expect(refusal(() => resolveSeriesRequest(signups, { from: '2026-9-1' }, NOW))[1]).toContain('from must be a date');
    expect(refusal(() => resolveSeriesRequest(signups, { from: '2026-09-10', to: '2026-09-01' }, NOW))).toEqual([400, 'from must not be after to']);
    expect(refusal(() => resolveSeriesRequest(signups, { to: '2026-09-29' }, NOW))).toEqual([400, 'to must not be in the future']);
    expect(refusal(() => resolveSeriesRequest(signups, { from: '2025-09-27', to: '2026-09-28' }, NOW))).toEqual([400, 'range is 367 days; this metric allows at most 366']);
    expect(resolveSeriesRequest(signups, { from: '2025-09-28', to: '2026-09-28' }, NOW).from).toBe('2025-09-28'); // exactly 366
    expect(refusal(() => resolveSeriesRequest(clubs, { grain: 'day' }, NOW))).toEqual([400, 'grain must be week or coarser']);
    expect(refusal(() => resolveSeriesRequest(signups, { grain: 'hour' }, NOW))).toEqual([400, 'grain must be one of day, week, month']);
  });
});

describe('rollupSeries', () => {
  it('fills every day of the range, keeps no-data as null (not 0), and bounds the breakdown', () => {
    const rows = [
      { day: '2026-09-01', plan: 'free', signups: 5 },
      { day: '2026-09-01', plan: 'pro', signups: 2 },
      { day: '2026-09-02', plan: 'free', signups: 0 },
      { day: '2026-09-03', plan: 'team', signups: 1 },
      { day: '2026-09-03', plan: 'pro', signups: 4 },
      { day: '2026-08-31', plan: 'free', signups: 99 }, // before the range
      { day: 'not a date', plan: 'free', signups: 50 },
      { day: '2026-09-02', plan: 'pro', signups: 'n/a' },
    ];
    const out = rollupSeries(signups, rows, { from: '2026-09-01', to: '2026-09-04', grain: 'day' });
    expect(out.buckets).toEqual(['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']);
    const m = out.measures[0]!;
    expect(m.summary).toBe(12);
    expect(m.series).toEqual([
      { dimension: 'pro', summary: 6, values: [2, null, 4, null] },
      { dimension: 'free', summary: 5, values: [5, 0, null, null] },
    ]);
    expect(out.omitted).toBe(1); // team
    expect(out.dimension).toEqual({ column: 'plan', label: 'Plan' });
  });

  it('rolls days up into Monday weeks and calendar months', () => {
    const rows = [
      { day: '2026-09-06', plan: 'free', signups: 1 }, // Sunday → week of Aug 31
      { day: '2026-09-07', plan: 'free', signups: 2 }, // Monday
      { day: Date.parse('2026-09-13T10:00:00Z'), plan: 'free', signups: 3 }, // epoch ms, Sunday
      { day: Date.parse('2026-10-01T00:00:00Z') / 1000, plan: 'free', signups: 4 }, // epoch s — after range
    ];
    const weeks = rollupSeries(signups, rows, { from: '2026-09-01', to: '2026-09-28', grain: 'week' });
    expect(weeks.buckets).toEqual(['2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28']);
    expect(weeks.measures[0]!.series[0]!.values).toEqual([1, 5, null, null, null]);
    const months = rollupSeries(signups, rows, { from: '2026-08-15', to: '2026-09-28', grain: 'month' });
    expect(months.buckets).toEqual(['2026-08-01', '2026-09-01']);
    expect(months.measures[0]!.series[0]!.values).toEqual([null, 6]);
  });

  it('applies each measure its own aggregation, per bucket and over the range', () => {
    const rows = [
      { week_start: '2026-09-07', attendance_rate: 80, events: 2, fees: 10 },
      { week_start: '2026-09-08', attendance_rate: 60, events: 1, fees: 30 }, // same week
      { week_start: '2026-09-14', attendance_rate: 90, events: 3, fees: 5 },
    ];
    const out = rollupSeries(clubs, rows, { from: '2026-09-07', to: '2026-09-20', grain: 'week' });
    expect(out.measures.map((m) => [m.label, m.summary, m.series[0]!.values])).toEqual([
      ['Attendance', (80 + 60 + 90) / 3, [70, 90]],
      ['Events', 6, [3, 3]],
      ['Fees', 30, [30, 5]],
    ]);
    expect(out.measures[2]).toMatchObject({ unit: 'currency', currency: 'GBP' });
  });

  it('an empty range is one all-null series without a breakdown, and no series with one', () => {
    const plain = rollupSeries(clubs, [], { from: '2026-09-07', to: '2026-09-20', grain: 'week' });
    expect(plain.measures.map((m) => [m.summary, m.series])).toEqual([
      [null, [{ dimension: null, summary: null, values: [null, null] }]],
      [null, [{ dimension: null, summary: null, values: [null, null] }]],
      [null, [{ dimension: null, summary: null, values: [null, null] }]],
    ]);
    const split = rollupSeries(signups, [], { from: '2026-09-01', to: '2026-09-02', grain: 'day' });
    expect(split.measures[0]).toMatchObject({ summary: null, series: [] });
    expect(split.omitted).toBe(0);
  });
});
