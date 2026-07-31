/**
 * Analytics Engine dataset names — single source of truth.
 *
 * AE datasets are addressed two different ways: the **binding** is declared in
 * wrangler.toml (write side) and the **dataset name** is the table in a CF
 * Analytics SQL API query (read side). Nothing links them, so the two drift
 * silently and the only symptom is a dashboard that reads zero forever.
 *
 * That already happened once: writes went to `pas_analytics` (wrangler.toml)
 * while every stats query read `pas_app_analytics`. Both names now come from
 * here, and wrangler.toml points at this file.
 *
 * Changing a value orphans existing data — AE has no rename. Treat these as
 * append-only.
 */

/** Visitor analytics — written by analytics-ingest.ts, read by analytics-stats-routes.ts. */
export const ANALYTICS_DATASET = 'pas_analytics';

/** Error telemetry — written by error-telemetry.ts (ADR-008 §1/§2). */
export const ERRORS_DATASET = 'pas_app_errors';
