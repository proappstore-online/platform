import { describe, expect, it } from 'vitest';
import { buildSeedMessages } from './prompts.ts';
import type { Ticket } from './types.ts';

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 't1', projectId: '', title: 'Add login', rawIdea: 'users can sign in',
    spec: null, status: 'ready', assigneeRole: null, iterations: 0,
    createdAt: 0, updatedAt: 0, costSpentUsd: 0, prUrl: null, finalCommitSha: null, stuckReason: null,
    ...overrides,
  };
}

describe('buildSeedMessages', () => {
  it('returns one PO message with the ticket framing', () => {
    const msgs = buildSeedMessages('BA', ticket(), 'myapp', []);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.author).toBe('po');
    expect(msgs[0]!.body).toContain('# Ticket: Add login');
    expect(msgs[0]!.body).toContain('users can sign in');
  });

  it('Dev gets the BA analysis + app id', () => {
    const prior = [{ author: 'BA', body: 'spec: a login form' }];
    const body = buildSeedMessages('Dev', ticket(), 'myapp', prior)[0]!.body;
    expect(body).toContain('## BA analysis');
    expect(body).toContain('a login form');
    expect(body).toContain('app id is "myapp"');
  });

  it('Dev on a qa-failed ticket gets the QA findings', () => {
    const prior = [
      { author: 'BA', body: 'spec' },
      { author: 'QA', body: 'button is broken' },
    ];
    const body = buildSeedMessages('Dev', ticket({ status: 'qa-failed' }), 'myapp', prior)[0]!.body;
    expect(body).toContain('QA found these issues');
    expect(body).toContain('button is broken');
  });

  it('QA is asked to report PASS or FAIL', () => {
    const body = buildSeedMessages('QA', ticket(), 'myapp', [{ author: 'BA', body: 'spec' }])[0]!.body;
    expect(body).toContain('## Spec to verify');
    expect(body).toContain('PASS or FAIL');
  });

  it('includes the approved spec summary when present', () => {
    const body = buildSeedMessages('Dev', ticket({ spec: { summary: 'SUMMARY', acceptanceCriteria: [], sdkPrimitives: [], filesToCreate: [], outOfScope: [], approvedBy: null, approvedAt: null, revisionOf: null } }), 'myapp', [])[0]!.body;
    expect(body).toContain('## Approved spec');
    expect(body).toContain('SUMMARY');
  });
});
