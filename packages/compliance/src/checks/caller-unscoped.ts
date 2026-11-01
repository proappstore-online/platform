import type { FileSource } from '../lib/file-source.js';
import type { CheckResult } from '../types.js';

const NAME = 'Caller-unscoped actions reported';

/**
 * #518: doordrop's "faithful port" left reads open with `caller_unscoped`, and the
 * gaps were closed one issue at a time (doordrop#28, #35, #41, #43, #85, #87) because
 * nothing surfaced them up front. `mcp-unscoped` (#426) already gates the subset that
 * is open to every signed-in user and may carry personal data; this check is the
 * plain inventory — every `auth.caller_unscoped` action in `mcp.json`, named with its
 * reason, regardless of role gating, as a warning. It changes no runtime behaviour.
 */
const GENERIC_REASONS = new Set(['legacy', 'port', 'ported', 'todo', 'tbd', 'wip', 'temp', 'temporary', 'fixme']);

function isGenericReason(reason: string): boolean {
  const trimmed = reason.trim().toLowerCase().replace(/[.!]+$/, '');
  return trimmed === '' || GENERIC_REASONS.has(trimmed);
}

interface CallerUnscopedTool {
  name?: unknown;
  auth?: { caller_unscoped?: { reason?: unknown } };
}

export async function checkCallerUnscoped(source: FileSource): Promise<CheckResult> {
  const raw = await source.read('mcp.json');
  if (raw === null) return { name: NAME, status: 'pass', detail: 'no mcp.json' };
  let manifest: { tools?: unknown };
  try {
    manifest = JSON.parse(raw) as typeof manifest;
  } catch {
    return { name: NAME, status: 'pass', detail: 'mcp.json is not valid JSON; registration reports it' };
  }
  const tools = (Array.isArray(manifest.tools) ? manifest.tools : [])
    .filter((t): t is CallerUnscopedTool => !!t && typeof t === 'object');

  const found = tools
    .filter((t) => t.auth?.caller_unscoped !== undefined)
    .map((t) => {
      const name = typeof t.name === 'string' ? t.name : '(unnamed)';
      const reason = typeof t.auth?.caller_unscoped?.reason === 'string' ? t.auth.caller_unscoped.reason.trim() : '';
      return { name, reason, generic: isGenericReason(reason) };
    });

  if (!found.length) return { name: NAME, status: 'pass', detail: 'no caller_unscoped action' };

  const lines = found.map((f) => f.generic
    ? `"${f.name}" [VAGUE REASON]: ${f.reason ? `"${f.reason}"` : 'no reason given'}`
    : `"${f.name}": "${f.reason}"`);
  const vague = found.filter((f) => f.generic).length;
  const detail = `${found.length} caller_unscoped action(s): ${lines.join('; ')}`;
  const suggestions = [
    'Each is an explicit exemption from the :__user_id scoping lint — confirm it still needs to be, and that the reason says what the action returns and why no caller can be identified.',
    'Scope it to the caller with :__user_id, or restrict it with auth.app_roles / callers, if it no longer needs the exemption.',
  ];
  if (vague) suggestions.push(`${vague} reason(s) are empty or generic ("legacy", "port", "todo", ...) and say nothing about why the exemption is safe — replace with a specific reason.`);
  return { name: NAME, status: 'warn', detail, suggestions };
}
