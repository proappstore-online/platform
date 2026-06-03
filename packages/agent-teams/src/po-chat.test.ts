import { describe, it, expect } from 'vitest';
import { extractJsonObject } from './po-chat.ts';

const START = '{"tool":"create_ticket"';

describe('extractJsonObject (PO create_ticket parsing)', () => {
  it('extracts a ticket whose text contains braces (the bug that dropped tickets)', () => {
    const text = 'Sure, here it is:\n' +
      '{"tool":"create_ticket","title":"Fix build","rawIdea":"User is { id, login, avatarUrl, dateOfBirth } only — no name/email."}\n' +
      "That's a single focused ticket.";
    const json = extractJsonObject(text, START);
    expect(json).not.toBeNull();
    const parsed = JSON.parse(json!) as { title: string; rawIdea: string };
    expect(parsed.title).toBe('Fix build');
    expect(parsed.rawIdea).toContain('{ id, login, avatarUrl, dateOfBirth }');
  });

  it('handles escaped quotes and newlines inside the value', () => {
    const text = '{"tool":"create_ticket","title":"t","rawIdea":"line1\\nsays \\"hi\\" and a } brace"}';
    const parsed = JSON.parse(extractJsonObject(text, START)!) as { rawIdea: string };
    expect(parsed.rawIdea).toContain('} brace');
    expect(parsed.rawIdea).toContain('"hi"');
  });

  it('returns null when the token is absent', () => {
    expect(extractJsonObject('no tool here', START)).toBeNull();
  });

  it('stops at the matching close, ignoring later braces in prose', () => {
    const text = '{"tool":"create_ticket","title":"t","rawIdea":"x"} then prose with { stray } braces';
    expect(extractJsonObject(text, START)).toBe('{"tool":"create_ticket","title":"t","rawIdea":"x"}');
  });
});
