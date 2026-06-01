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
  // QA passes → done
  { from: 'qa-active', to: 'done', trigger: 'QA' },
  // QA fails → back to Dev
  { from: 'qa-active', to: 'qa-failed', trigger: 'QA' },
  // QA is stuck → needs user input
  { from: 'qa-active', to: 'needs-input', trigger: 'QA' },
  // Dev picks up failed ticket
  { from: 'qa-failed', to: 'dev-active', trigger: 'Dev' },

  // User answers a question → resume to previous active state
  // (system puts it back to the right status based on assignee)
  { from: 'needs-input', to: 'ba-refining', trigger: 'system' },
  { from: 'needs-input', to: 'dev-active', trigger: 'system' },
  { from: 'needs-input', to: 'qa-active', trigger: 'system' },
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
 * Decide a QA verdict from the QA agent's free-text report. The QA prompt asks
 * it to report PASS or FAIL; any FAIL signal routes the ticket back to Dev.
 * Ambiguous output defaults to 'done' (the iteration cap guards against loops).
 */
export function qaVerdict(output: string): 'done' | 'qa-failed' {
  return /\bFAIL(ED|S|URE)?\b/i.test(output) ? 'qa-failed' : 'done';
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
