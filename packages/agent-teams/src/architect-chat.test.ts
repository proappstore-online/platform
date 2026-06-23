import { describe, expect, it } from 'vitest';
import { wantsKbAuthoring } from './architect-chat.ts';

/**
 * Intent gate for the "must write KNOWLEDGE.md before finishing" nudge (the fix
 * for the coffeerating case: 13 reads, 0 writes, "Done."). Must fire for KB
 * authoring requests and stay quiet for ordinary research-tab Q&A.
 */
describe('wantsKbAuthoring', () => {
  it('fires for the canonical KB-authoring prompt', () => {
    expect(wantsKbAuthoring('Research this app and write its Knowledge Base — KNOWLEDGE.md plus docs/ — as the team\'s source of truth.')).toBe(true);
  });
  it('fires for paraphrases', () => {
    expect(wantsKbAuthoring('author the knowledge base please')).toBe(true);
    expect(wantsKbAuthoring('create KNOWLEDGE.md for this')).toBe(true);
    expect(wantsKbAuthoring('build out the Knowledge Base')).toBe(true);
  });
  it('stays quiet for plain Q&A / chat', () => {
    expect(wantsKbAuthoring('what data model should I use?')).toBe(false);
    expect(wantsKbAuthoring('who are the competitors?')).toBe(false);
    expect(wantsKbAuthoring('explain the knowledge base concept to me')).toBe(false); // asks ABOUT it, no write verb
    expect(wantsKbAuthoring('great, thanks!')).toBe(false);
  });
});
