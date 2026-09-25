/**
 * Tool dispatch for runtime adapters.
 *
 * Every autonomous run executes its tools through the executor the ProjectDO
 * injects at prepare() time (`PrepareContext.dispatch`): file tools against the
 * in-memory working tree, `read_docs` against the docs cache. Deployment is a
 * deterministic system stage over the ADMIN service binding with INTERNAL_TOKEN
 * (deploy-stage.ts), not an agent tool. So there is no second executor: runs
 * never carry a user session, and no tool call ever leaves the Worker on the
 * owner's behalf (#2, closes the "owner session token in the DO" follow-up).
 *
 * `dispatchTool` is the fallback a runtime reaches only when it was prepared
 * without an executor — a programming error, answered as a failed tool result
 * so the run surfaces it instead of hanging.
 */

import type { ToolCall, ToolResult } from './types.ts';

export function dispatchTool(toolCall: ToolCall): Promise<ToolResult> {
  return Promise.resolve({
    callId: toolCall.id,
    ok: false,
    errorMessage: `Tool "${toolCall.name}" has no executor: the runtime was prepared without a dispatch function (autonomous runs execute tools inside the project DO)`,
    durationMs: 0,
  });
}

/**
 * Validate that a tool name is in the allowed spine tools list.
 */
export function isAllowedTool(name: string, spineTools: string[]): boolean {
  return spineTools.includes(name);
}
