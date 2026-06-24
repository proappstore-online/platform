import { describe, expect, it } from 'vitest';
import { buildFallbackKnowledge, decideArchitectTurn, wantsKbAuthoring } from './architect-chat.ts';

/**
 * Intent gate for the "must write KNOWLEDGE.md before finishing" nudge (the fix
 * for the coffeerating case: reads only, 0 writes, "Done."). Must fire for KB
 * authoring requests and stay quiet for ordinary research-tab Q&A.
 */
describe('wantsKbAuthoring', () => {
  it('fires for the canonical KB-authoring prompt', () => {
    expect(wantsKbAuthoring("Research this app and write its Knowledge Base — KNOWLEDGE.md plus docs/ — as the team's source of truth.")).toBe(true);
  });
  it('fires for paraphrases', () => {
    expect(wantsKbAuthoring('author the knowledge base please')).toBe(true);
    expect(wantsKbAuthoring('create KNOWLEDGE.md for this')).toBe(true);
    expect(wantsKbAuthoring('build out the Knowledge Base')).toBe(true);
    expect(wantsKbAuthoring('document the app in the knowledge base')).toBe(true);
  });
  it('stays quiet for plain Q&A / chat', () => {
    expect(wantsKbAuthoring('what data model should I use?')).toBe(false);
    expect(wantsKbAuthoring('who are the competitors?')).toBe(false);
    expect(wantsKbAuthoring('explain the knowledge base concept to me')).toBe(false); // asks ABOUT it, no write verb
    expect(wantsKbAuthoring('great, thanks!')).toBe(false);
  });
});

/**
 * Turn decision — the control flow that caused the orphaned-tool_use 400. The
 * invariant: when ANY tool_use is pending we must 'process' it (answer with a
 * tool_result), never 'nudge'/'finish' — a user message after an unanswered
 * tool_use is an invalid history → Anthropic 400.
 */
describe('decideArchitectTurn', () => {
  it('ALWAYS processes pending tool calls — even when a KB nudge is otherwise due (orphan-400 fix)', () => {
    // This exact combo (tools pending + wantsKb + !wrote + !nudged) is what the
    // old `|| stop_reason !== 'tool_use'` branch turned into a nudge → 400.
    expect(decideArchitectTurn({ toolUseCount: 1, wantsKb: true, wrote: false, alreadyNudged: false })).toBe('process');
    expect(decideArchitectTurn({ toolUseCount: 3, wantsKb: true, wrote: false, alreadyNudged: true })).toBe('process');
    expect(decideArchitectTurn({ toolUseCount: 2, wantsKb: false, wrote: true, alreadyNudged: false })).toBe('process');
  });

  it('nudges once when the KB was requested, nothing was written, and no tools are pending', () => {
    expect(decideArchitectTurn({ toolUseCount: 0, wantsKb: true, wrote: false, alreadyNudged: false })).toBe('nudge');
  });

  it('does not nudge twice (one-shot)', () => {
    expect(decideArchitectTurn({ toolUseCount: 0, wantsKb: true, wrote: false, alreadyNudged: true })).toBe('finish');
  });

  it('finishes once a KB file has been written', () => {
    expect(decideArchitectTurn({ toolUseCount: 0, wantsKb: true, wrote: true, alreadyNudged: false })).toBe('finish');
  });

  it('finishes plain Q&A without ever nudging', () => {
    expect(decideArchitectTurn({ toolUseCount: 0, wantsKb: false, wrote: false, alreadyNudged: false })).toBe('finish');
  });
});

/**
 * Last-resort KB synthesis — guarantees the Research tab is never empty after a
 * build, even if the model wrote nothing (the coffeerating symptom).
 */
describe('buildFallbackKnowledge', () => {
  const mem = [
    { id: '1', category: 'fact', key: 'app_purpose', value: 'Rate coffee by location, anonymously.', createdAt: 0, updatedAt: 0 },
    { id: '2', category: 'fact', key: 'target_users', value: 'Coffee drinkers.', createdAt: 0, updatedAt: 0 },
  ];
  it('renders gathered facts under a titled draft KB', () => {
    const md = buildFallbackKnowledge('Coffee Rating', 'Anonymous coffee ratings.', mem);
    expect(md).toContain('# Coffee Rating');
    expect(md).toContain('Anonymous coffee ratings.');
    expect(md).toContain('Draft Knowledge Base');
    expect(md).toContain('**app purpose**: Rate coffee by location, anonymously.'); // key humanized
    expect(md).toContain('**target users**: Coffee drinkers.');
  });
  it('handles no captured facts gracefully', () => {
    const md = buildFallbackKnowledge('My App', undefined, []);
    expect(md).toContain('# My App');
    expect(md).toContain('No durable facts');
  });
});
