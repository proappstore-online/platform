import { actionCallers, type ToolManifest } from '../action-sql.js';
import { validateHookVerify, type HookVerify } from '../hook-verifiers.js';

// ── Inbound webhooks (#256) ──────────────────────────────────────────────────

const MAX_HOOKS_PER_APP = 10;
export const HOOK_NAME = /^[a-z][a-z0-9_-]{0,49}$/;
/** `$`, `$.a.b`, `$.a[0]` — a path into the verified JSON body. No expressions. */
const HOOK_PARAM_PATH = /^\$(\.[A-Za-z_][A-Za-z0-9_]*|\[\d{1,4}\])*$/;

export type HookTarget = 'worker' | { action: string; params: Record<string, unknown> };
export interface HookDef { name: string; verify: HookVerify; to: HookTarget }

/**
 * The `hooks` section. `to: "worker"` delivers to the app worker; `to: { action,
 * params }` runs one registered write as `system:hook`, with params mapped from
 * the body by path or given as literals. The action must be a hook action:
 * `callers` including "hook", unscoped with a reason, no role gate — the same
 * rules as a scheduled action, which a signed-in user cannot run unless it also
 * lists "user".
 */
export function validateHooks(raw: unknown, tools: ToolManifest[]): { error: string } | { hooks: HookDef[] } {
  if (raw === undefined || raw === null) return { hooks: [] };
  if (!Array.isArray(raw) || raw.length > MAX_HOOKS_PER_APP) return { error: `hooks must be an array of at most ${MAX_HOOKS_PER_APP} hooks` };
  const hooks: HookDef[] = [];
  for (const [i, item] of raw.entries()) {
    const at = `hooks[${i}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { error: `${at} must be an object` };
    const unknown = Object.keys(item).find((k) => !['name', 'verify', 'to'].includes(k));
    if (unknown) return { error: `${at}: unknown field "${unknown}"` };
    const { name, verify, to } = item as { name?: unknown; verify?: unknown; to?: unknown };
    if (typeof name !== 'string' || !HOOK_NAME.test(name)) return { error: `${at}.name must match ${HOOK_NAME.source}` };
    if (hooks.some((h) => h.name === name)) return { error: `${at}: duplicate name "${name}"` };
    const v = validateHookVerify(verify, at);
    if ('error' in v) return v;
    let target: HookTarget;
    if (to === 'worker') {
      target = 'worker';
    } else if (to && typeof to === 'object' && !Array.isArray(to)) {
      const extra = Object.keys(to).find((k) => k !== 'action' && k !== 'params');
      if (extra) return { error: `${at}.to: unknown field "${extra}"` };
      const { action, params = {} } = to as { action?: unknown; params?: unknown };
      const tool = tools.find((t) => t.name === action);
      if (typeof action !== 'string' || !tool) return { error: `${at}.to.action must name an action in this manifest` };
      if (tool.operation !== 'execute' && tool.operation !== 'batch') return { error: `${at}.to.action "${action}" must be an execute or batch action` };
      if (!actionCallers(tool).includes('hook')) return { error: `${at}.to.action "${action}" must list "hook" in its callers` };
      if (tool.requires_auth !== true || !tool.auth?.caller_unscoped?.reason) return { error: `${at}.to.action "${action}" must require auth and declare auth.caller_unscoped with a reason (it runs as system:hook)` };
      if (tool.auth.app_roles?.length || tool.auth.platform_roles?.length) return { error: `${at}.to.action "${action}" cannot be role-gated (system:hook holds no role)` };
      if (tool.schedule !== undefined) return { error: `${at}.to.action "${action}" is a scheduled action` };
      if (!params || typeof params !== 'object' || Array.isArray(params)) return { error: `${at}.to.params must be an object` };
      for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
        if (!(key in (tool.params ?? {}))) return { error: `${at}.to.params: "${key}" is not a param of "${action}"` };
        if (typeof value === 'string' && value.startsWith('$') && !HOOK_PARAM_PATH.test(value)) return { error: `${at}.to.params.${key}: "${value}" is not a path like $.a.b or $.a[0]` };
        if (value !== null && typeof value === 'object') return { error: `${at}.to.params.${key} must be a path or a literal` };
      }
      target = { action, params: params as Record<string, unknown> };
    } else {
      return { error: `${at}.to must be "worker" or { action, params }` };
    }
    hooks.push({ name, verify: v.verify, to: target });
  }
  return { hooks };
}
