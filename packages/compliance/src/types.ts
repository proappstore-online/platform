export type CheckStatus = 'pass' | 'warn' | 'fail';

/** Where a check's evidence comes from — the standard's evidence classes
 *  (docs/standard/audit-model.md#evidence-classes). */
export type EvidenceClass = 'configuration' | 'source' | 'process' | 'runtime' | 'documentation';

/**
 * How much of the cited clause the check proves.
 *   full    — the check is the clause's automated enforcement; a pass is the clause's evidence.
 *   partial — the check proves one observable facet; the rest of the clause needs a
 *             manual or human review (see the clause's Verification line).
 */
export type CheckAutomation = 'full' | 'partial';

/** A clickable citation into the public Application Standard. */
export interface StandardCitation {
  /** Stable clause id, e.g. `PAS-UI-007`. */
  clauseId: string;
  /** Public URL with the clause anchor, e.g. https://docs.proappstore.online/standard/ui/#pas-ui-007 */
  url: string;
}

export interface CheckResult {
  /** Short human-readable name. */
  name: string;
  /** pass | warn | fail. fail is a hard gate; warn is informational. */
  status: CheckStatus;
  /** One-line context (file path, count, current value). */
  detail: string;
  /** Optional actionable advice for fixing a fail/warn. */
  suggestions?: string[];
  /** Stable check id (kebab-case, never renamed), e.g. `no-tracking`. Added by the runner (#166). */
  checkId?: string;
  /** Clauses of the Application Standard this check evidences, with public URLs. */
  citations?: StandardCitation[];
  /** Whether the check is the clause's full automated enforcement or only a partial signal. */
  automation?: CheckAutomation;
  /** The evidence the result rests on: its class and the `detail` text as the observation. */
  evidence?: { class: EvidenceClass; detail: string };
}
