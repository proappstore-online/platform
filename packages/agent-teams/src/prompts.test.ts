import { describe, expect, it } from 'vitest';
import { buildSeedMessages, buildPOSystemPrompt, buildArchitectChatSystemPrompt } from './prompts.ts';
import type { Ticket } from './types.ts';

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 't1', seq: 1, projectId: '', title: 'Add login', rawIdea: 'users can sign in',
    spec: null, status: 'ready', kind: 'build', assigneeRole: null, iterations: 0,
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

  it('Dev re-fixing after a failed deploy/test is pointed at the error + the tests', () => {
    const body = buildSeedMessages('Dev', ticket({ iterations: 1 }), 'myapp', [{ author: 'BA', body: 'spec' }])[0]!.body;
    expect(body).toContain('A previous deploy or test run failed');
    expect(body).toContain('tests/unit/');
  });

  it('QA writes vitest unit/integration tests + ends with READY/BLOCKED', () => {
    const body = buildSeedMessages('QA', ticket(), 'myapp', [{ author: 'BA', body: 'spec' }])[0]!.body;
    expect(body).toContain('## Acceptance criteria to test');
    expect(body).toContain("write_file");
    expect(body).toContain('tests/unit/');
    expect(body).toContain('vitest');
    expect(body).toContain('VERDICT: READY');
  });

  it('includes the approved spec summary when present', () => {
    const body = buildSeedMessages('Dev', ticket({ spec: { summary: 'SUMMARY', acceptanceCriteria: [], sdkPrimitives: [], filesToCreate: [], outOfScope: [], approvedBy: null, approvedAt: null, revisionOf: null } }), 'myapp', [])[0]!.body;
    expect(body).toContain('## Approved spec');
    expect(body).toContain('SUMMARY');
  });

  it('Dev/QA get the cached app context summary when available', () => {
    const files = ['src/main.tsx', 'src/App.tsx'];
    const summary = '# App Context Summary\n\n## Components\n- App\n## SDK Usage\n- app.auth';
    const dev = buildSeedMessages('Dev', ticket(), 'myapp', [], files, '', '', summary)[0]!.body;
    expect(dev).toContain('# App Context Summary');
    expect(dev).toContain('app.auth');
    // File list is still included alongside the summary
    expect(dev).toContain('## File list (2)');
  });

  it('falls back to raw file list when no context summary is available', () => {
    const files = ['src/main.tsx', 'src/App.tsx'];
    const dev = buildSeedMessages('Dev', ticket(), 'myapp', [], files)[0]!.body;
    expect(dev).toContain('## Existing files (2)');
    expect(dev).not.toContain('App Context Summary');
  });

  it('QA also gets the context summary', () => {
    const summary = '# App Context Summary\n\n## SDK Usage\n- app.db';
    const qa = buildSeedMessages('QA', ticket(), 'myapp', [{ author: 'BA', body: 'spec' }], ['src/App.tsx'], '', '', summary)[0]!.body;
    expect(qa).toContain('# App Context Summary');
    expect(qa).toContain('app.db');
  });

  it('BA does not get the context summary (only Dev/QA)', () => {
    const summary = '# App Context Summary\n\n## Components\n- App';
    const ba = buildSeedMessages('BA', ticket(), 'myapp', [], [], '', '', summary)[0]!.body;
    expect(ba).not.toContain('App Context Summary');
  });

  it('Architect gets KB-writing instructions and app slug', () => {
    const body = buildSeedMessages('Architect', ticket(), 'myapp', [])[0]!.body;
    expect(body).toContain('KNOWLEDGE.md');
    expect(body).toContain('"myapp"');
    expect(body).toContain('batch_write_files');
  });

  it('Dev gets previous system error when retrying', () => {
    const prior = [
      { author: 'BA', body: 'spec' },
      { author: 'system', body: 'Deploy failed — fix and it will redeploy:\ntsc error TS2345' },
    ];
    const body = buildSeedMessages('Dev', ticket({ iterations: 1 }), 'myapp', prior)[0]!.body;
    expect(body).toContain('## Previous run error');
    expect(body).toContain('TS2345');
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

describe('buildArchitectChatSystemPrompt', () => {
  const ctx = { appName: 'Tasker', slug: 'tasker', appIdea: 'a todo app', memoryBlock: '', fileList: [] as string[] };

  it('tells the Architect it has live web access (web_search + web_fetch)', () => {
    const p = buildArchitectChatSystemPrompt(ctx);
    expect(p).toContain('LIVE WEB ACCESS');
    expect(p).toContain('web_search');
    expect(p).toContain('web_fetch');
  });

  it('requires actually searching the web for market/competitor work (no recall from memory)', () => {
    const p = buildArchitectChatSystemPrompt(ctx);
    expect(p).toMatch(/market research|competitor|find the gap/i);
    expect(p).toMatch(/never answer from memory|MUST actually search/i);
  });

  it('owns the Knowledge Base only — not tickets or building', () => {
    const p = buildArchitectChatSystemPrompt(ctx);
    expect(p).toContain('KNOWLEDGE.md');
    expect(p).toMatch(/do NOT create build tickets/i);
  });
});
