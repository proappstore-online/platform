/**
 * Anthropic Messages SSE stream parser for the CFNativeRuntime.
 */

import type { StreamEvent } from '../types.ts';
import type { AnthropicContent, AnthropicResponse } from './cf-native-types.ts';

/**
 * Parse the Anthropic Messages SSE stream into a complete response. Emits
 * text-delta events live as tokens arrive; assembles text + tool_use blocks
 * (tool input from concatenated input_json_delta) and the final stop_reason.
 */
export async function* parseAnthropicStream(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent, AnthropicResponse> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const content: AnthropicContent[] = [];
  const partialJson: Record<number, string> = {};
  let stopReason: AnthropicResponse['stop_reason'] = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let buf = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let ev: Record<string, unknown>;
      try { ev = JSON.parse(data); } catch { continue; }

      switch (ev.type) {
        case 'message_start': {
          const u = (ev.message as { usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } })?.usage;
          // Count cached reads + cache writes toward input so the cost meter
          // reflects total tokens processed (Anthropic reports them separately).
          if (u) inputTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
          break;
        }
        case 'content_block_start': {
          const idx = ev.index as number;
          const cb = ev.content_block as { type: string; id?: string; name?: string; text?: string };
          if (cb.type === 'text') content[idx] = { type: 'text', text: cb.text ?? '' };
          else if (cb.type === 'tool_use') { content[idx] = { type: 'tool_use', id: cb.id!, name: cb.name!, input: {} }; partialJson[idx] = ''; }
          break;
        }
        case 'content_block_delta': {
          const idx = ev.index as number;
          const d = ev.delta as { type: string; text?: string; partial_json?: string };
          if (d.type === 'text_delta') {
            const b = content[idx];
            if (b?.type === 'text') b.text += d.text ?? '';
            if (d.text) yield { type: 'text-delta', text: d.text };
          } else if (d.type === 'input_json_delta') {
            partialJson[idx] = (partialJson[idx] ?? '') + (d.partial_json ?? '');
          }
          break;
        }
        case 'content_block_stop': {
          const idx = ev.index as number;
          const b = content[idx];
          if (b?.type === 'tool_use') {
            try { b.input = JSON.parse(partialJson[idx] || '{}'); } catch { b.input = {}; }
          }
          break;
        }
        case 'message_delta': {
          const delta = ev.delta as { stop_reason?: AnthropicResponse['stop_reason'] };
          if (delta?.stop_reason) stopReason = delta.stop_reason;
          const u = ev.usage as { output_tokens?: number } | undefined;
          if (u?.output_tokens != null) outputTokens = u.output_tokens; // cumulative
          break;
        }
      }
    }
  }

  return {
    id: 'stream',
    content: content.filter(Boolean),
    stop_reason: stopReason,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    model: '',
  };
}
