/**
 * App-wide metric time series (#240): a `metrics` resource may declare
 * `series`, read through the owner-only metrics route instead of as one KPI row.
 *
 *   "series": {
 *     "time":      { "column", "grain": "day" | "week" | "month" },      // the grain the query returns
 *     "range":     { "from_param", "to_param", "default_days", "max_days" },
 *     "measures":  [{ "column", "label", "unit", "currency"?, "aggregation" }],   // 1-4
 *     "dimension"?: { "column", "label", "max_values" }                  // one measure only
 *   }
 *
 * The platform passes the requested range (ISO dates) to the query's two range
 * params, then rolls the returned rows up into grain buckets with each
 * measure's aggregation. Everything the console shows is bounded: the query
 * must end with a literal LIMIT, the range with max_days, the breakdown with
 * max_values.
 */
import { literalLimit, type ToolManifest } from './action-sql.js';
import { isObj, optionalParam, text, unknownField, type OperatorColumn } from './operator-contract-shared.js';

export const SERIES_GRAINS = ['day', 'week', 'month'] as const;
const SERIES_AGGREGATIONS = ['sum', 'avg', 'min', 'max'] as const;
const SERIES_UNITS = ['count', 'percent', 'seconds', 'bytes', 'currency'] as const;
const MAX_MEASURES = 4;
const MAX_DIMENSION_VALUES = 8;
const MAX_SERIES_DAYS = 731;
const MAX_SERIES_ROWS = 5000;

export type SeriesGrain = (typeof SERIES_GRAINS)[number];
type SeriesAggregation = (typeof SERIES_AGGREGATIONS)[number];

interface SeriesMeasure {
  column: string;
  label: string;
  unit: (typeof SERIES_UNITS)[number];
  /** ISO 4217 code, when unit is currency. */
  currency: string | null;
  aggregation: SeriesAggregation;
}

export interface OperatorSeries {
  time: { column: string; grain: SeriesGrain };
  range: { from_param: string; to_param: string; default_days: number; max_days: number };
  measures: SeriesMeasure[];
  dimension: { column: string; label: string; max_values: number } | null;
}

const int = (v: unknown, min: number, max: number) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

function validateMeasure(value: unknown, columns: OperatorColumn[], at: string): SeriesMeasure | string {
  if (!isObj(value)) return `${at} must be an object`;
  const extra = unknownField(value, ['column', 'label', 'unit', 'currency', 'aggregation'], at);
  if (extra) return extra;
  if (!columns.some((c) => c.key === value.column)) return `${at}: column must be a declared column`;
  const label = text(value.label, 40);
  if (!label) return `${at}: label is required (max 40 chars)`;
  if (!SERIES_UNITS.includes(value.unit as SeriesMeasure['unit'])) return `${at}: unit must be one of ${SERIES_UNITS.join(', ')}`;
  let currency: string | null = null;
  if (value.unit === 'currency') {
    if (typeof value.currency !== 'string' || !/^[A-Z]{3}$/.test(value.currency)) return `${at}: currency must be an ISO 4217 code (e.g. EUR) when unit is currency`;
    currency = value.currency;
  } else if (value.currency !== undefined) {
    return `${at}: currency is only allowed when unit is currency`;
  }
  if (!SERIES_AGGREGATIONS.includes(value.aggregation as SeriesAggregation)) {
    return `${at}: aggregation must be one of ${SERIES_AGGREGATIONS.join(', ')}`;
  }
  return { column: value.column as string, label, unit: value.unit as SeriesMeasure['unit'], currency, aggregation: value.aggregation as SeriesAggregation };
}

function validateTime(columns: OperatorColumn[], time: unknown, at: string): OperatorSeries['time'] | string {
  if (!isObj(time)) return `${at} must be an object`;
  const extra = unknownField(time, ['column', 'grain'], at);
  if (extra) return extra;
  if (!columns.some((c) => c.key === time.column)) return `${at}: column must be a declared column`;
  if (!SERIES_GRAINS.includes(time.grain as SeriesGrain)) return `${at}: grain must be one of ${SERIES_GRAINS.join(', ')}`;
  return { column: time.column as string, grain: time.grain as SeriesGrain };
}

function validateRange(tool: ToolManifest, range: unknown, at: string): OperatorSeries['range'] | string {
  if (!isObj(range)) return `${at} must be an object`;
  const extra = unknownField(range, ['from_param', 'to_param', 'default_days', 'max_days'], at)
    ?? optionalParam(tool, range.from_param, at) ?? optionalParam(tool, range.to_param, at);
  if (extra) return extra;
  if (range.from_param === range.to_param) return `${at}: from_param and to_param must differ`;
  if (!int(range.max_days, 1, MAX_SERIES_DAYS)) return `${at}: max_days must be an integer from 1 to ${MAX_SERIES_DAYS}`;
  if (!int(range.default_days, 1, range.max_days as number)) return `${at}: default_days must be an integer from 1 to max_days`;
  return { from_param: range.from_param as string, to_param: range.to_param as string, default_days: range.default_days as number, max_days: range.max_days as number };
}

function validateDimension(columns: OperatorColumn[], used: string[], measures: number, d: unknown, at: string): OperatorSeries['dimension'] | string {
  if (!isObj(d)) return `${at} must be an object`;
  const extra = unknownField(d, ['column', 'label', 'max_values'], at);
  if (extra) return extra;
  if (!columns.some((c) => c.key === d.column)) return `${at}: column must be a declared column`;
  if (used.includes(d.column as string)) return `${at}: column "${String(d.column)}" is already used`;
  const label = text(d.label, 40);
  if (!label) return `${at}: label is required (max 40 chars)`;
  if (!int(d.max_values, 1, MAX_DIMENSION_VALUES)) return `${at}: max_values must be an integer from 1 to ${MAX_DIMENSION_VALUES}`;
  if (measures !== 1) return `${at}: a breakdown takes exactly one measure`;
  return { column: d.column as string, label, max_values: d.max_values as number };
}

export function validateSeries(tool: ToolManifest, columns: OperatorColumn[], value: unknown, where: string): OperatorSeries | string {
  const at = `${where}.series`;
  if (!isObj(value)) return `${at} must be an object`;
  const extra = unknownField(value, ['time', 'range', 'measures', 'dimension'], at);
  if (extra) return extra;
  const time = validateTime(columns, value.time, `${at}.time`);
  if (typeof time === 'string') return time;
  const range = validateRange(tool, value.range, `${at}.range`);
  if (typeof range === 'string') return range;
  const limit = literalLimit(tool.sql ?? '');
  if (limit === null || limit < 1 || limit > MAX_SERIES_ROWS) {
    return `${at}: action "${tool.name}" must end with a literal LIMIT of 1-${MAX_SERIES_ROWS}`;
  }

  if (!Array.isArray(value.measures) || value.measures.length === 0 || value.measures.length > MAX_MEASURES) {
    return `${at}.measures must be an array of 1-${MAX_MEASURES}`;
  }
  const measures: SeriesMeasure[] = [];
  for (const [i, m] of value.measures.entries()) {
    const measure = validateMeasure(m, columns, `${at}.measures[${i}]`);
    if (typeof measure === 'string') return measure;
    if (measure.column === time.column || measures.some((x) => x.column === measure.column)) {
      return `${at}.measures[${i}]: column "${measure.column}" is already used`;
    }
    measures.push(measure);
  }

  const used = [time.column, ...measures.map((m) => m.column)];
  const dimension = value.dimension === undefined ? null : validateDimension(columns, used, measures.length, value.dimension, `${at}.dimension`);
  if (typeof dimension === 'string') return dimension;
  return { time, range, measures, dimension };
}
