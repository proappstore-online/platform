import { describe, it, expect } from 'vitest';
import { messagesToAnthropic, trimConversation } from './cf-native-helpers.ts';
import type { AnthropicMessage } from './cf-native-types.ts';
import type { Message } from '../types.ts';

describe('messagesToAnthropic', () => {
  const msg = (author: string, body: string): Message => ({
    id: 'x', ticketId: 't', author: author as Message['author'], body,
    createdAt: 0, costUsd: 0, tokensIn: 0, tokensOut: 0,
  });

  it('maps po/system to user, others to assistant', () => {
    const result = messagesToAnthropic([msg('po', 'hi'), msg('Dev', 'code')]);
    expect(result[0].role).toBe('user');
    expect(result[1].role).toBe('assistant');
  });

  it('handles messages with tool calls and results', () => {
    const m: Message = {
      ...msg('Dev', 'writing'),
      toolCalls: [{
        id: 'tc1', name: 'write_file', args: { path: 'a.ts', content: 'x' },
        result: { callId: 'tc1', ok: true, data: 'Wrote a.ts', durationMs: 0 },
      }],
    };
    const result = messagesToAnthropic([m]);
    expect(result).toHaveLength(2); // assistant + user (tool_result)
    expect(result[0].content).toHaveLength(2); // text + tool_use
    expect(result[1].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'tc1' });
  });
});

describe('trimConversation', () => {
  const userMsg = (text: string): AnthropicMessage => ({
    role: 'user', content: [{ type: 'text', text }],
  });

  const toolResultMsg = (content: string, id = 'tc1'): AnthropicMessage => ({
    role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }],
  });

  it('does nothing when under budget', () => {
    const msgs: AnthropicMessage[] = [userMsg('seed'), userMsg('short')];
    trimConversation(msgs);
    expect(msgs[1].content[0]).toMatchObject({ type: 'text', text: 'short' });
  });

  it('trims old tool_result blocks when over budget', () => {
    const bigContent = 'x'.repeat(700_000); // ~175k tokens, over 150k budget
    const msgs: AnthropicMessage[] = [
      userMsg('seed'),
      toolResultMsg(bigContent, 'old'), // old — should be trimmed
      userMsg('recent-1'),
      userMsg('recent-2'),
      userMsg('recent-3'),
      userMsg('recent-4'),
    ];
    trimConversation(msgs);
    // Old tool_result trimmed
    const trimmedBlock = msgs[1].content[0];
    expect(trimmedBlock).toMatchObject({ type: 'tool_result' });
    expect((trimmedBlock as { content: string }).content).toContain('trimmed');
    expect((trimmedBlock as { content: string }).content).toContain('700000');
    // Recent messages untouched
    expect(msgs[5].content[0]).toMatchObject({ type: 'text', text: 'recent-4' });
  });

  it('preserves the seed message (index 0)', () => {
    const bigContent = 'x'.repeat(700_000);
    const msgs: AnthropicMessage[] = [
      toolResultMsg(bigContent, 'seed'), // index 0 — protected
      toolResultMsg(bigContent, 'old'),  // index 1 — trimmable
      userMsg('a'), userMsg('b'), userMsg('c'), userMsg('d'),
    ];
    trimConversation(msgs);
    // Seed (index 0) NOT trimmed
    expect((msgs[0].content[0] as { content: string }).content).toBe(bigContent);
    // Index 1 IS trimmed
    expect((msgs[1].content[0] as { content: string }).content).toContain('trimmed');
  });

  it('preserves the last 4 messages', () => {
    const bigContent = 'x'.repeat(700_000);
    const msgs: AnthropicMessage[] = [
      userMsg('seed'),
      toolResultMsg(bigContent, 'old'),
      toolResultMsg(bigContent, 'tail1'), // index 2 — part of last 4
      userMsg('tail2'),
      userMsg('tail3'),
      userMsg('tail4'),
    ];
    trimConversation(msgs);
    // Index 2 is in the last 4 — should NOT be trimmed
    expect((msgs[2].content[0] as { content: string }).content).toBe(bigContent);
  });

  it('keeps short tool_result blocks intact', () => {
    const bigContent = 'x'.repeat(700_000);
    const msgs: AnthropicMessage[] = [
      userMsg('seed'),
      toolResultMsg('short result', 'short'),
      toolResultMsg(bigContent, 'big'),
      userMsg('a'), userMsg('b'), userMsg('c'), userMsg('d'),
    ];
    trimConversation(msgs);
    // Short result (<200 chars) not trimmed
    expect((msgs[1].content[0] as { content: string }).content).toBe('short result');
    // Big result trimmed
    expect((msgs[2].content[0] as { content: string }).content).toContain('trimmed');
  });
});
