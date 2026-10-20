import type { FileSource } from '../lib/file-source.js';
import { evaluateUnscoped, isOpenUnscoped, validateApprovals, type UnscopedPolicyTool } from '../lib/unscoped-policy.js';
import type { CheckResult } from '../types.js';

const NAME = 'Unscoped actions approved';

/**
 * #426 (PAS-DATA-012): every action in `mcp.json` that any signed-in user can run
 * without `:__user_id` (`auth.caller_unscoped`, no role, callable by "user") must
 * have a reviewed `approved_unscoped` entry and must not return personal data.
 *
 * The platform's registration gate applies the same policy (lib/unscoped-policy.ts)
 * with the app's registered actions in hand, grandfathering unchanged ones. This
 * check has no registry, so it warns on every gap the gate might accept today and
 * fails only on what no approval fixes: a malformed approval list, or an approved
 * action that returns personal data or `*`.
 */
export async function checkMcpUnscoped(source: FileSource): Promise<CheckResult> {
  const raw = await source.read('mcp.json');
  if (raw === null) return { name: NAME, status: 'pass', detail: 'no mcp.json' };
  let manifest: { tools?: unknown; approved_unscoped?: unknown };
  try {
    manifest = JSON.parse(raw) as typeof manifest;
  } catch {
    return { name: NAME, status: 'pass', detail: 'mcp.json is not valid JSON; registration reports it' };
  }
  const tools = (Array.isArray(manifest.tools) ? manifest.tools : [])
    .filter((t): t is UnscopedPolicyTool => !!t && typeof t === 'object' && typeof (t as { name?: unknown }).name === 'string');
  const approvals = validateApprovals(manifest.approved_unscoped);
  if ('error' in approvals) {
    return { name: NAME, status: 'fail', detail: approvals.error, suggestions: ['Each approved_unscoped entry is { "action", "reviewer", "date": "YYYY-MM-DD", "reason" }.'] };
  }
  const open = tools.filter(isOpenUnscoped).length;
  const verdict = evaluateUnscoped({ tools, approvals: approvals.approvals, previous: null });
  const suggestions = [
    'Scope the statement to the caller with :__user_id, gate it with auth.app_roles, or narrow callers to ["worker"].',
    'A reviewed, shared read with no personal data: add { "action", "reviewer", "date", "reason" } to approved_unscoped.',
  ];
  if (verdict.errors.length) return { name: NAME, status: 'fail', detail: verdict.errors.join('; '), suggestions };
  if (verdict.warnings.length) return { name: NAME, status: 'warn', detail: verdict.warnings.join('; '), suggestions };
  return { name: NAME, status: 'pass', detail: open ? `${open} unscoped action(s), all approved, none returning personal data` : 'no action is open to every user unscoped' };
}
