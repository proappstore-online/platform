import { describe, it, expect } from 'vitest';
import {
  canTransition,
  validNextStates,
  assigneeForStatus,
  isTerminal,
  needsUserAction,
  qaVerdict,
  MAX_ITERATIONS,
  MAX_RUN_MINUTES,
  IDLE_TIMEOUT_MINUTES,
  MAX_CONCURRENT_ACTIVE,
} from './ticket-machine.ts';

describe('canTransition', () => {
  // Happy path: full lifecycle
  it('BA picks up inbox ticket', () => {
    expect(canTransition('inbox', 'ba-refining', 'BA')).toBe(true);
  });

  it('BA finishes spec', () => {
    expect(canTransition('ba-refining', 'awaiting-approval', 'BA')).toBe(true);
  });

  it('PO approves spec', () => {
    expect(canTransition('awaiting-approval', 'ready', 'po')).toBe(true);
  });

  it('PO rejects spec back to BA', () => {
    expect(canTransition('awaiting-approval', 'ba-refining', 'po')).toBe(true);
  });

  it('Dev picks up ready ticket', () => {
    expect(canTransition('ready', 'dev-active', 'Dev')).toBe(true);
  });

  it('Dev finishes, hands to QA', () => {
    expect(canTransition('dev-active', 'qa-active', 'Dev')).toBe(true);
  });

  it('QA passes', () => {
    expect(canTransition('qa-active', 'done', 'QA')).toBe(true);
  });

  it('QA fails, back to Dev', () => {
    expect(canTransition('qa-active', 'qa-failed', 'QA')).toBe(true);
  });

  it('Dev picks up failed ticket', () => {
    expect(canTransition('qa-failed', 'dev-active', 'Dev')).toBe(true);
  });

  // PO cancellations
  it('PO can cancel from inbox', () => {
    expect(canTransition('inbox', 'cancelled', 'po')).toBe(true);
  });

  it('PO can cancel from dev-active', () => {
    expect(canTransition('dev-active', 'cancelled', 'po')).toBe(true);
  });

  // System failures
  it('system can fail ba-refining', () => {
    expect(canTransition('ba-refining', 'failed', 'system')).toBe(true);
  });

  it('system can fail dev-active', () => {
    expect(canTransition('dev-active', 'failed', 'system')).toBe(true);
  });

  // Invalid transitions
  it('Dev cannot pick up inbox directly', () => {
    expect(canTransition('inbox', 'dev-active', 'Dev')).toBe(false);
  });

  it('BA cannot mark done', () => {
    expect(canTransition('ba-refining', 'done', 'BA')).toBe(false);
  });

  it('QA cannot go back to ba-refining', () => {
    expect(canTransition('qa-active', 'ba-refining', 'QA')).toBe(false);
  });

  it('cannot transition from done', () => {
    expect(canTransition('done', 'inbox', 'po')).toBe(false);
  });

  it('cannot transition from cancelled', () => {
    expect(canTransition('cancelled', 'inbox', 'po')).toBe(false);
  });

  it('PO cannot directly set dev-active', () => {
    expect(canTransition('ready', 'dev-active', 'po')).toBe(false);
  });
});

describe('validNextStates', () => {
  it('inbox can go to ba-refining (BA) or cancelled (PO)', () => {
    expect(validNextStates('inbox', 'BA')).toEqual(['ba-refining']);
    expect(validNextStates('inbox', 'po')).toEqual(['cancelled']);
  });

  it('awaiting-approval: PO can approve or reject', () => {
    const next = validNextStates('awaiting-approval', 'po');
    expect(next).toContain('ready');
    expect(next).toContain('ba-refining');
    expect(next).toContain('cancelled');
  });

  it('qa-active: QA can pass or fail', () => {
    const next = validNextStates('qa-active', 'QA');
    expect(next).toContain('done');
    expect(next).toContain('qa-failed');
  });

  it('done has no valid next states', () => {
    expect(validNextStates('done', 'po')).toEqual([]);
    expect(validNextStates('done', 'Dev')).toEqual([]);
    expect(validNextStates('done', 'system')).toEqual([]);
  });
});

describe('assigneeForStatus', () => {
  it('ba-refining → BA', () => expect(assigneeForStatus('ba-refining')).toBe('BA'));
  it('dev-active → Dev', () => expect(assigneeForStatus('dev-active')).toBe('Dev'));
  it('qa-failed → Dev', () => expect(assigneeForStatus('qa-failed')).toBe('Dev'));
  it('qa-active → QA', () => expect(assigneeForStatus('qa-active')).toBe('QA'));
  it('inbox → null', () => expect(assigneeForStatus('inbox')).toBeNull());
  it('ready → null', () => expect(assigneeForStatus('ready')).toBeNull());
  it('done → null', () => expect(assigneeForStatus('done')).toBeNull());
});

describe('isTerminal', () => {
  it('done is terminal', () => expect(isTerminal('done')).toBe(true));
  it('failed is terminal', () => expect(isTerminal('failed')).toBe(true));
  it('cancelled is terminal', () => expect(isTerminal('cancelled')).toBe(true));
  it('inbox is not terminal', () => expect(isTerminal('inbox')).toBe(false));
  it('dev-active is not terminal', () => expect(isTerminal('dev-active')).toBe(false));
  it('qa-failed is not terminal', () => expect(isTerminal('qa-failed')).toBe(false));
});

describe('needs-input state', () => {
  it('BA can move to needs-input', () => {
    expect(canTransition('ba-refining', 'needs-input', 'BA')).toBe(true);
  });
  it('Dev can move to needs-input', () => {
    expect(canTransition('dev-active', 'needs-input', 'Dev')).toBe(true);
  });
  it('QA can move to needs-input', () => {
    expect(canTransition('qa-active', 'needs-input', 'QA')).toBe(true);
  });
  it('system can resume from needs-input to ba-refining', () => {
    expect(canTransition('needs-input', 'ba-refining', 'system')).toBe(true);
  });
  it('system can resume from needs-input to dev-active', () => {
    expect(canTransition('needs-input', 'dev-active', 'system')).toBe(true);
  });
  it('PO can cancel from needs-input', () => {
    expect(canTransition('needs-input', 'cancelled', 'po')).toBe(true);
  });
  it('system can fail from needs-input', () => {
    expect(canTransition('needs-input', 'failed', 'system')).toBe(true);
  });
});

describe('needsUserAction', () => {
  it('needs-input needs user action', () => expect(needsUserAction('needs-input')).toBe(true));
  it('awaiting-approval needs user action', () => expect(needsUserAction('awaiting-approval')).toBe(true));
  it('dev-active does not', () => expect(needsUserAction('dev-active')).toBe(false));
  it('inbox does not', () => expect(needsUserAction('inbox')).toBe(false));
});

describe('qaVerdict', () => {
  it('fails on an explicit VERDICT: FAIL marker', () => expect(qaVerdict('Issues found.\nVERDICT: FAIL')).toBe('qa-failed'));
  it('passes on an explicit VERDICT: PASS marker', () => expect(qaVerdict('All good.\nVERDICT: PASS')).toBe('done'));
  it('is case-insensitive on the marker', () => expect(qaVerdict('verdict: fail')).toBe('qa-failed'));
  // The regression that burned a whole budget: a PASS report whose rubric is
  // full of the word "FAIL" must NOT be read as a failure.
  it('passes a PASS report that mentions FAIL in its rubric', () =>
    expect(qaVerdict('| Criterion | PASS or FAIL |\n| auth | ✅ PASS |\nNo blocking defects.\nVERDICT: PASS')).toBe('done'));
  it('uses the LAST marker when retractions appear above it', () =>
    expect(qaVerdict('## 🔴 FAIL — compile blockers\nActually not a blocker.\nVERDICT: PASS')).toBe('done'));
  it('defaults to done when no marker is present (CI is the real gate)', () =>
    expect(qaVerdict('Looks good to me, shipping.')).toBe('done'));
});

describe('safety constants', () => {
  it('MAX_ITERATIONS is 5', () => expect(MAX_ITERATIONS).toBe(5));
  it('MAX_RUN_MINUTES is 10', () => expect(MAX_RUN_MINUTES).toBe(10));
  it('IDLE_TIMEOUT_MINUTES is 30', () => expect(IDLE_TIMEOUT_MINUTES).toBe(30));
  it('MAX_CONCURRENT_ACTIVE is 3', () => expect(MAX_CONCURRENT_ACTIVE).toBe(3));
});
