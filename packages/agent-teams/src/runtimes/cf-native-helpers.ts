/**
 * Conversion helpers for the CFNativeRuntime: platform Message history ↔
 * Anthropic message format, and spine tool name → Anthropic tool definition.
 */

import type { Message } from '../types.ts';
import { TOOL_SCHEMAS } from '../tool-schemas.ts';
import type { AnthropicContent, AnthropicMessage, AnthropicTool } from './cf-native-types.ts';

export function messagesToAnthropic(messages: Message[]): AnthropicMessage[] {
  const result: AnthropicMessage[] = [];
  for (const msg of messages) {
    const role = msg.author === 'po' || msg.author === 'system' ? 'user' : 'assistant';
    const content: AnthropicContent[] = [{ type: 'text', text: msg.body }];

    // One assistant message holds the text + ALL tool_use blocks; the matching
    // tool_result blocks then go together in ONE following user message. (The old
    // code pushed the accumulating `content` once per tool-with-result AND again
    // below, duplicating tool_use blocks and orphaning tool_results → Anthropic
    // 400s. Currently history collapses to a single text message so this was
    // latent, but keep it correct for any future tool-call replay.)
    const toolResults: AnthropicContent[] = [];
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
        if (tc.result) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tc.id,
            content: tc.result.ok
              ? (typeof tc.result.data === 'string' ? tc.result.data : JSON.stringify(tc.result.data))
              : (tc.result.errorMessage ?? 'failed'),
          });
        }
      }
    }

    result.push({ role, content });
    if (toolResults.length > 0) result.push({ role: 'user', content: toolResults });
  }
  return result;
}

export function nameToToolDef(name: string): AnthropicTool {
  const def = TOOL_SCHEMAS[name];
  if (!def) return { name, description: `Tool: ${name}`, input_schema: { type: 'object', properties: {} } };
  return { name, description: def.description, input_schema: def.parameters };
}

/**
 * Rough char->token estimate (1 token ~ 4 chars). Good enough for budget guards.
 */
function estimateTokens(msgs: AnthropicMessage[]): number {
  let chars = 0;
  for (const m of msgs) {
    for (const b of m.content) {
      if (b.type === 'text') chars += b.text.length;
      else if (b.type === 'tool_result') chars += b.content.length;
      else if (b.type === 'tool_use') chars += JSON.stringify(b.input).length;
    }
  }
  return Math.ceil(chars / 4);
}

/**
 * Trim the conversation to stay under the model context budget. Keeps the seed
 * message (first) and the last 4 messages intact. Older tool_result blocks with
 * content > 200 chars are replaced with a short summary. Mutates in place.
 *
 * 150k threshold leaves ~50k for system prompt + tool defs + output.
 */
const CONTEXT_BUDGET = 150_000; // tokens

export function trimConversation(msgs: AnthropicMessage[]): void {
  if (estimateTokens(msgs) < CONTEXT_BUDGET) return;
  // Keep first message (seed) + last 4 messages untouched.
  const protectedTail = 4;
  const trimEnd = Math.max(1, msgs.length - protectedTail);
  for (let i = 1; i < trimEnd; i++) {
    const m = msgs[i]!;
    let changed = false;
    const trimmed: AnthropicContent[] = m.content.map((b): AnthropicContent => {
      if (b.type === 'tool_result' && b.content.length > 200) {
        changed = true;
        return { type: 'tool_result', tool_use_id: b.tool_use_id, content: `(trimmed - was ${b.content.length} chars)` };
      }
      return b;
    });
    if (changed) msgs[i] = { role: m.role, content: trimmed };
  }
}
