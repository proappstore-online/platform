import type { FileSource } from './file-source.js';

/**
 * "Is this a game project?" — used by checks that diverge between apps
 * (ProAppStore) and games (ProAppStore (games)). Apps run inside a sidebar+
 * scrolling Shell; games run inside a viewport-locked GameShell with
 * different brand tokens. Several rules need to know which they're
 * looking at.
 *
 * Detection signals (any one is sufficient):
 *   - `@proappstore/games` listed in any package.json
 *   - A TS/JS source file imports from `@proappstore/games`
 *
 * Both signals exist because workspace hoisting can put the dep in the
 * root package.json (where a per-app scan would miss it) and template
 * scaffolds put the import in app source.
 */
export async function isGameProject(source: FileSource): Promise<boolean> {
  for await (const path of source.list()) {
    const base = path.split('/').pop() ?? '';
    if (base !== 'package.json') continue;
    const content = await source.read(path);
    if (content && /@proappstore\/games/.test(content)) return true;
  }
  for await (const path of source.list()) {
    if (!path.endsWith('.ts') && !path.endsWith('.tsx')) continue;
    const content = await source.read(path);
    if (content && /from\s+['"]@proappstore\/games['"]/.test(content)) return true;
  }
  return false;
}

