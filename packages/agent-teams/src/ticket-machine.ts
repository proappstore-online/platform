/**
 * Ticket state machine — defines valid transitions and who can trigger them.
 */

import type { Role, TicketStatus } from './types.ts';

interface Transition {
  from: TicketStatus;
  to: TicketStatus;
  trigger: 'po' | Role | 'system';
}

const TRANSITIONS: Transition[] = [
  // PO creates ticket → BA picks it up
  { from: 'inbox', to: 'ba-refining', trigger: 'BA' },
  // BA finishes spec → PO reviews
  { from: 'ba-refining', to: 'awaiting-approval', trigger: 'BA' },
  // BA is stuck → needs user input
  { from: 'ba-refining', to: 'needs-input', trigger: 'BA' },
  // PO approves → ready for Dev
  { from: 'awaiting-approval', to: 'ready', trigger: 'po' },
  // PO rejects → back to BA
  { from: 'awaiting-approval', to: 'ba-refining', trigger: 'po' },
  // Dev picks up
  { from: 'ready', to: 'dev-active', trigger: 'Dev' },
  // Dev finishes → QA
  { from: 'dev-active', to: 'qa-active', trigger: 'Dev' },
  // Dev is stuck → needs user input
  { from: 'dev-active', to: 'needs-input', trigger: 'Dev' },
  // QA passes → deploy stage (deterministic system stage; SHA-verified CI gate).
  // The auto-orchestrator drives qa-active→deploying directly; the legacy
  // qa-active→done edge is kept for back-compat with any manual flow.
  { from: 'qa-active', to: 'deploying', trigger: 'QA' },
  { from: 'qa-active', to: 'deploying', trigger: 'system' },
  { from: 'qa-active', to: 'done', trigger: 'QA' },
  // QA fails → back to Dev
  { from: 'qa-active', to: 'qa-failed', trigger: 'QA' },
  // QA is stuck → needs user input
  { from: 'qa-active', to: 'needs-input', trigger: 'QA' },
  // Dev picks up failed ticket
  { from: 'qa-failed', to: 'dev-active', trigger: 'Dev' },

  // Deploy stage (deploy-stage.ts) outcomes — all system-driven:
  // CI green → done (verified live); CI red → back to Dev with the error;
  // can't verify / never started → failed; PO may cancel a hung deploy.
  { from: 'deploying', to: 'done', trigger: 'system' },
  { from: 'deploying', to: 'dev-active', trigger: 'system' },
  { from: 'deploying', to: 'failed', trigger: 'system' },
  { from: 'deploying', to: 'cancelled', trigger: 'po' },

  // User answers a question → resume to previous active state
  // (system puts it back to the right status based on assignee)
  { from: 'needs-input', to: 'ba-refining', trigger: 'system' },
  { from: 'needs-input', to: 'dev-active', trigger: 'system' },
  { from: 'needs-input', to: 'qa-active', trigger: 'system' },
  // Deploy-infra block (null assignee) retried via Play → straight back to deploy.
  { from: 'needs-input', to: 'deploying', trigger: 'system' },
  { from: 'needs-input', to: 'ready', trigger: 'po' },

  // PO can cancel from any active state
  { from: 'inbox', to: 'cancelled', trigger: 'po' },
  { from: 'ba-refining', to: 'cancelled', trigger: 'po' },
  { from: 'awaiting-approval', to: 'cancelled', trigger: 'po' },
  { from: 'ready', to: 'cancelled', trigger: 'po' },
  { from: 'dev-active', to: 'cancelled', trigger: 'po' },
  { from: 'qa-active', to: 'cancelled', trigger: 'po' },
  { from: 'qa-failed', to: 'cancelled', trigger: 'po' },
  { from: 'needs-input', to: 'cancelled', trigger: 'po' },

  // System can fail from active states (cost cap, iteration cap, stuck, timeout)
  { from: 'ba-refining', to: 'failed', trigger: 'system' },
  { from: 'dev-active', to: 'failed', trigger: 'system' },
  { from: 'qa-active', to: 'failed', trigger: 'system' },
  { from: 'qa-failed', to: 'failed', trigger: 'system' },
  { from: 'needs-input', to: 'failed', trigger: 'system' },
];

export function canTransition(
  from: TicketStatus,
  to: TicketStatus,
  trigger: 'po' | Role | 'system',
): boolean {
  return TRANSITIONS.some(
    (t) => t.from === from && t.to === to && t.trigger === trigger,
  );
}

export function validNextStates(
  from: TicketStatus,
  trigger: 'po' | Role | 'system',
): TicketStatus[] {
  return TRANSITIONS
    .filter((t) => t.from === from && t.trigger === trigger)
    .map((t) => t.to);
}

/** Which role should pick up a ticket in a given status? */
export function assigneeForStatus(status: TicketStatus): Role | null {
  switch (status) {
    case 'ba-refining':
      return 'BA';
    case 'dev-active':
    case 'qa-failed':
      return 'Dev';
    case 'qa-active':
      return 'QA';
    default:
      return null;
  }
}

/** Is this a terminal state? */
export function isTerminal(status: TicketStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled';
}

/**
 * Decide a QA verdict from the QA agent's report. The QA prompt requires a final
 * line `VERDICT: PASS` or `VERDICT: FAIL` — we parse the LAST such marker so the
 * essay above it (full of "PASS"/"FAIL" in tables and criteria names) can't flip
 * the result. Only an explicit `VERDICT: FAIL` routes back to Dev; anything else
 * (PASS, or no marker at all) advances — the CI build gate is the real
 * compile check, and the iteration cap guards against loops.
 *
 * Historical bug: this used to grep for the word "FAIL" anywhere, so every
 * PASS report (which always contains "FAIL" in its rubric) bounced to Dev until
 * the iteration cap — burning the whole budget on a working app.
 */
export function qaVerdict(output: string): 'done' | 'qa-failed' {
  const markers = [...output.matchAll(/VERDICT:\s*(PASS|FAIL)/gi)];
  if (markers.length > 0) {
    return markers[markers.length - 1]![1]!.toUpperCase() === 'FAIL' ? 'qa-failed' : 'done';
  }
  return 'done'; // no explicit verdict → don't loop; CI build gate catches real breakage
}

/**
 * Decide whether a BA spec is buildable or blocked on the founder. The BA ends
 * with `VERDICT: READY` (spec complete) or `VERDICT: BLOCKED` (genuine product/
 * scope decision needed). BLOCKED → the ticket parks in needs-input with the
 * questions, so Dev isn't loosed on an unspecced ticket. Default READY (no marker
 * → proceed) so a forgetful BA doesn't stall every ticket — same bias as
 * qaVerdict. Last marker wins (the essay above can mention both words).
 */
export function baVerdict(output: string): 'ready' | 'blocked' {
  const markers = [...output.matchAll(/VERDICT:\s*(READY|BLOCKED)/gi)];
  if (markers.length > 0) {
    return markers[markers.length - 1]![1]!.toUpperCase() === 'BLOCKED' ? 'blocked' : 'ready';
  }
  return 'ready';
}

/** Is this a state where the user needs to respond? */
export function needsUserAction(status: TicketStatus): boolean {
  return status === 'needs-input' || status === 'awaiting-approval';
}

/** Max QA→Dev iterations before auto-fail */
export const MAX_ITERATIONS = 5;

/** Max minutes a single agent run can take before timeout */
export const MAX_RUN_MINUTES = 10;

/** Auto-pause after this many minutes of no user chat activity */
export const IDLE_TIMEOUT_MINUTES = 30;

/** Max tickets that can be active (ba-refining + dev-active + qa-active) at once */
export const MAX_CONCURRENT_ACTIVE = 3;
