/**
 * Pure sliding-window rate limiter. Kept storage-agnostic so it's unit-testable
 * and reusable (the DO holds the timestamp list in memory per project).
 *
 * Returns whether the action is allowed and the pruned timestamp list to persist.
 */
export function slidingWindowAllow(
  times: readonly number[],
  now: number,
  limit: number,
  windowMs: number,
): { allowed: boolean; times: number[] } {
  const recent = times.filter((t) => now - t < windowMs);
  if (recent.length >= limit) return { allowed: false, times: recent };
  return { allowed: true, times: [...recent, now] };
}

// Per-account cap on agent-teams projects (each project = a repo + infra), to
// stop runaway creation. Re-creating a slug you already own doesn't count.
export const MAX_PROJECTS_PER_USER = 25;

// Per-project chat throttle: the PO agent runs an LLM call per message, so cap
// founder messages to a sane burst (the monthly cost cap is the hard backstop).
export const CHAT_LIMIT = 20;
export const CHAT_WINDOW_MS = 60_000;
