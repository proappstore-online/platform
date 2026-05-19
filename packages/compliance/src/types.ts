export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface CheckResult {
  /** Short human-readable name. */
  name: string;
  /** pass | warn | fail. fail is a hard gate; warn is informational. */
  status: CheckStatus;
  /** One-line context (file path, count, current value). */
  detail: string;
  /** Optional actionable advice for fixing a fail/warn. */
  suggestions?: string[];
}
