/**
 * Extracts the PWA manifest object that vite-plugin-pwa embeds inline in
 * `web/vite.config.ts`. The plugin call looks like:
 *
 *     VitePWA({
 *       registerType: 'autoUpdate',
 *       manifest: {
 *         name: 'My Game',
 *         short_name: 'My Game',
 *         start_url: '/',
 *         display: 'standalone',
 *         ...
 *       },
 *     })
 *
 * We don't run a full TS parser — that would pull in ts-morph or
 * @babel/parser just for one field. Instead we balance braces from the
 * `manifest:` keyword and pull primitive top-level keys out of the
 * resulting block with focused regexes. Robust enough for the patterns
 * the games actually use; falls back to `null` on anything weird.
 */

export interface InlineManifest {
  name?: string | undefined;
  short_name?: string | undefined;
  start_url?: string | undefined;
  display?: string | undefined;
  orientation?: string | undefined;
  min_viewport_width?: number | undefined;
  icons?: unknown;
}

export function extractInlineManifest(viteConfig: string): InlineManifest | null {
  const start = viteConfig.search(/\bmanifest\s*:\s*\{/);
  if (start < 0) return null;
  const openIdx = viteConfig.indexOf('{', start);
  if (openIdx < 0) return null;

  // Balance braces to find the end of the manifest object literal.
  // Handles nested objects (icons array entries) and quoted strings
  // (so a `}` inside a quoted value isn't counted).
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let escape = false;
  let endIdx = -1;
  for (let i = openIdx; i < viteConfig.length; i++) {
    const ch = viteConfig[i]!;
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      continue;
    }
    if (inBacktick) {
      if (ch === '`') inBacktick = false;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === '`') {
      inBacktick = true;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
  }
  if (endIdx < 0) return null;

  const block = viteConfig.slice(openIdx + 1, endIdx);

  const readString = (key: string): string | undefined => {
    const re = new RegExp(`(?:^|[\\s,])${key}\\s*:\\s*['"\`]([^'"\`]*)['"\`]`);
    const m = block.match(re);
    return m ? m[1] : undefined;
  };
  const readNumber = (key: string): number | undefined => {
    const re = new RegExp(`(?:^|[\\s,])${key}\\s*:\\s*(\\d+(?:\\.\\d+)?)`);
    const m = block.match(re);
    return m ? Number(m[1]) : undefined;
  };
  const hasIcons = /(?:^|[\s,])icons\s*:\s*\[/.test(block);

  return {
    name: readString('name'),
    short_name: readString('short_name'),
    start_url: readString('start_url'),
    display: readString('display'),
    orientation: readString('orientation'),
    min_viewport_width: readNumber('min_viewport_width'),
    icons: hasIcons || undefined,
  };
}
