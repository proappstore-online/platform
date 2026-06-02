/**
 * Anthropic Messages API wire types used by the CFNativeRuntime.
 */

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicContent[];
}

export type AnthropicContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string };

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface AnthropicResponse {
  id: string;
  content: AnthropicContent[];
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | null;
  usage: { input_tokens: number; output_tokens: number };
  model: string;
}
