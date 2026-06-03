/**
 * Validation for per-role agent configs (the PUT /roles endpoint). Pure and
 * self-contained so the catalogs and bounds live in one place (and are unit
 * testable) instead of inline in ProjectDO.
 */
import type { RoleConfig } from './types.ts';

export const VALID_ROLES = new Set(['Architect', 'BA', 'Dev', 'QA']);
export const VALID_RUNTIMES = new Set(['cf-native', 'openai-responses']);
/** Spine tools a role may be granted. Keep in sync with spine.ts dispatch. */
export const VALID_SPINE_TOOLS = new Set([
  'write_file', 'read_file', 'list_files', 'delete_file',
  'search_files', 'batch_write_files', 'read_docs',
]);

/** Returns the first validation error for a role config, or null when valid. */
export function validateRoleConfig(rc: RoleConfig): string | null {
  if (!VALID_ROLES.has(rc.role)) return `invalid role: ${rc.role}`;
  if (!VALID_RUNTIMES.has(rc.runtime)) return `invalid runtime: ${rc.runtime}`;
  if (!rc.model || rc.model.length > 64) return 'model must be 1-64 chars';
  for (const tool of rc.spineTools) {
    if (!VALID_SPINE_TOOLS.has(tool)) return `unknown spine tool: ${tool}`;
  }
  if (rc.systemPromptOverride && rc.systemPromptOverride.length > 8192) {
    return 'systemPromptOverride too long (max 8KB)';
  }
  if (rc.maxTokens != null && (!Number.isInteger(rc.maxTokens) || rc.maxTokens < 1024 || rc.maxTokens > 64000)) {
    return 'maxTokens must be an integer between 1024 and 64000';
  }
  if (rc.persona && rc.persona.length > 4096) return 'persona too long (max 4KB)';
  return null;
}
