import { describe, expect, it } from 'vitest';
import { buildSeedMessages, buildPOSystemPrompt } from './prompts.ts';
import type { Ticket } from './types.ts';

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 't1', seq: 1, projectId: '', title: 'Add login', rawIdea: 'users can sign in',
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

  it('injects project memory (decisions) as ground truth for the agent', () => {
    const body = buildSeedMessages('Dev', ticket(), 'app', [], [], '## Project memory — decisions & facts (treat as ground truth)\n- auth: GitHub OAuth')[0]!.body;
    expect(body).toContain('Project memory');
    expect(body).toContain('auth: GitHub OAuth');
  });

  it('Dev/QA get the seeded file tree (no list_files round-trip needed)', () => {
    const files = ['src/main.tsx', 'src/App.tsx', 'package.json'];
    const dev = buildSeedMessages('Dev', ticket(), 'myapp', [], files)[0]!.body;
    expect(dev).toContain('## Existing files (3)');
    expect(dev).toContain('src/App.tsx');
    const ba = buildSeedMessages('BA', ticket(), 'myapp', [], files)[0]!.body;
    expect(ba).not.toContain('Existing files');
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

  it('QA is asked to end with a VERDICT marker', () => {
    const body = buildSeedMessages('QA', ticket(), 'myapp', [{ author: 'BA', body: 'spec' }])[0]!.body;
    expect(body).toContain('## Spec to verify');
    expect(body).toContain('VERDICT: PASS');
  });

  it('includes the approved spec summary when present', () => {
    const body = buildSeedMessages('Dev', ticket({ spec: { summary: 'SUMMARY', acceptanceCriteria: [], sdkPrimitives: [], filesToCreate: [], outOfScope: [], approvedBy: null, approvedAt: null, revisionOf: null } }), 'myapp', [])[0]!.body;
    expect(body).toContain('## Approved spec');
    expect(body).toContain('SUMMARY');
  });
});

describe('buildPOSystemPrompt', () => {
  const base = { appName: 'Interns', slug: 'interns', memoryBlock: '', backlogSummary: '', fileList: [] as string[] };

  it('frames the PO around the app, not the platform', () => {
    const p = buildPOSystemPrompt({ ...base, appIdea: 'manage interns' });
    expect(p).toContain('"Interns"');
    expect(p).toContain('ProAppStore is NOT this app');
    expect(p).toContain('manage interns');
  });

  it('lists the backlog with #N numbers and the quote instruction', () => {
    const p = buildPOSystemPrompt({ ...base, backlogSummary: '- #3 [inbox] Add auth' });
    expect(p).toContain('- #3 [inbox] Add auth');
    expect(p).toContain('#N');
    expect(p).toContain('Never invent a ticket number');
  });

  it('falls back to an ask-first line when no idea is known, and renders file list', () => {
    const p = buildPOSystemPrompt({ ...base, fileList: ['src/App.tsx'] });
    expect(p).toContain('ASK them what they\'re building');
    expect(p).toContain('Current app files (1)');
    expect(p).toContain('src/App.tsx');
  });
});
