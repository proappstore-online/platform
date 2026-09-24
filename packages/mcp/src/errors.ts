/**
 * Structured tool errors (#114). A thrown error is converted to an `isError`
 * result by the MCP SDK, but a handler that RETURNS an error message as plain
 * text is indistinguishable from success to a caller that does not parse the
 * text. Every explicit failure return goes through here instead.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export function errText(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}
