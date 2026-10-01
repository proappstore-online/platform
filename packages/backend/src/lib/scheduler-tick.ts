/**
 * The platform scheduler's tick, in minutes — the single source of truth (#281).
 *
 * The backend's only cron trigger (`wrangler.toml` `[triggers] crons`) must be
 * `*\/${SCHEDULER_TICK_MINUTES} * * * *`; the runtime suite's wrangler drift test
 * asserts it. Registration (`routes/tools.ts`) rejects cron minutes off this
 * tick, and the executor (`lib/scheduled-actions.ts`) sizes its due window from it.
 * Kept dependency-free so the plain-Node drift test can import it.
 */
export const SCHEDULER_TICK_MINUTES = 5;
