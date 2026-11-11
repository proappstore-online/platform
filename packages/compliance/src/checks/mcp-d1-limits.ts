import type { FileSource } from '../lib/file-source.js';
import { actionD1LimitError, D1_MAX_BOUND_PARAMS, D1_MAX_COMPOUND_TERMS } from '../lib/d1-limits.js';
import type { CheckResult } from '../types.js';

const NAME = 'Actions fit D1 limits';

/**
 * #571 (PAS-DATA-023): every statement in `mcp.json` binds at most 100 parameters
 * and has at most 5 terms in any one compound SELECT, the limits D1 enforces and
 * local SQLite does not.
 *
 * The platform's registration gate refuses a new or changed action over a limit
 * and only warns for one registered unchanged, which already fails on every call.
 * This check has no registry, so it warns: a failure here would break the
 * `prebuild` of an app whose broken action is still registered.
 */
export async function checkMcpD1Limits(source: FileSource): Promise<CheckResult> {
  const raw = await source.read('mcp.json');
  if (raw === null) return { name: NAME, status: 'pass', detail: 'no mcp.json' };
  let manifest: { tools?: unknown };
  try {
    manifest = JSON.parse(raw) as typeof manifest;
  } catch {
    return { name: NAME, status: 'pass', detail: 'mcp.json is not valid JSON; registration reports it' };
  }
  const tools = (Array.isArray(manifest.tools) ? manifest.tools : [])
    .filter((t): t is { name: string } => !!t && typeof t === 'object' && typeof (t as { name?: unknown }).name === 'string');
  const errors = tools.map(actionD1LimitError).filter((e): e is string => e !== null);
  if (!errors.length) {
    return { name: NAME, status: 'pass', detail: `${tools.length} action(s) within ${D1_MAX_BOUND_PARAMS} parameters and ${D1_MAX_COMPOUND_TERMS} compound terms per statement` };
  }
  return {
    name: NAME,
    status: 'warn',
    detail: `${errors.join('; ')}. Registration refuses a new or changed action like this; D1 refuses every call to one already registered`,
    suggestions: [
      'Bind each repeated value once, e.g. JOIN (SELECT :from AS d_from) p, and refer to p.d_from.',
      `Nest a long UNION in parenthesised groups of at most ${D1_MAX_COMPOUND_TERMS} terms.`,
      'Run every registered statement against Miniflare\'s D1 in the app\'s tests: local SQLite allows 32,766 parameters and 500 terms.',
    ],
  };
}
