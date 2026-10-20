import type { FileSource } from '../lib/file-source.js';
import { detectPermissions, permissionInfo, validatePermissions } from '../lib/permissions.js';
import type { CheckResult } from '../types.js';

const NAME = 'Permissions declared';

/**
 * #437: every browser permission the app's code uses is declared in mcp.json
 * `permissions`, with a one-line reason, so its storefront listing can say why.
 * The listing shows declared and detected permissions together, so an undeclared
 * one still appears, just without a reason: this is a warning, never a failure.
 */
export async function checkPermissions(source: FileSource): Promise<CheckResult> {
  const files: [string, string][] = [];
  for await (const path of source.list()) {
    const text = await source.read(path);
    if (text !== null) files.push([path, text]);
  }
  const detected = detectPermissions(files);
  const raw = await source.read('mcp.json');
  let declaredRaw: unknown;
  try { declaredRaw = raw ? (JSON.parse(raw) as { permissions?: unknown }).permissions : undefined; } catch { declaredRaw = undefined; }
  const validated = validatePermissions(declaredRaw);
  if ('error' in validated) {
    return { name: NAME, status: 'warn', detail: `mcp.json ${validated.error}`, suggestions: ['Declare as "permissions": [{ "id": "microphone", "reason": "Record voice notes" }].'] };
  }
  const declared = new Set(validated.permissions.map((p) => p.id));
  const undeclared = detected.filter((id) => !declared.has(id));
  if (undeclared.length) {
    return {
      name: NAME,
      status: 'warn',
      detail: `uses ${undeclared.map((id) => permissionInfo(id)!.name.toLowerCase()).join(', ')} without declaring it in mcp.json permissions: the listing shows it with no reason`,
      suggestions: [`Add to mcp.json: "permissions": [${undeclared.map((id) => `{ "id": "${id}", "reason": "…" }`).join(', ')}]`],
    };
  }
  const all = [...new Set([...detected, ...declared])];
  return { name: NAME, status: 'pass', detail: all.length ? `declares ${all.join(', ')}` : 'uses no special browser permissions' };
}
