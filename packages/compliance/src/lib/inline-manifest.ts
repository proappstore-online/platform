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
  /** Literal source of the icons array, if present. Used by checks that
   * need to inspect per-icon fields (e.g. maskable `purpose`). */
  iconsRaw?: string | undefined;
}

export function extractInlineManifest(viteConfig: string): InlineManifest | null {
  const start = viteConfig.search(/\bmanifest\s*:\s*\{/);
  if (start < 0) return null;
  const openIdx = viteConfig.indexOf('{', start);
  if (openIdx < 0) return null;

  // Balance braces to find the end of the manifest object literal.
  // Handles nested objects (icons array entries) and quoted strings
  // (so a `}` inside a quoted value isn't counted).
  const endIdx = matchingClose(viteConfig, openIdx, '{', '}');
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
  const iconsRaw = extractIconsArray(block);

  return {
    name: readString('name'),
    short_name: readString('short_name'),
    start_url: readString('start_url'),
    display: readString('display'),
    orientation: readString('orientation'),
    min_viewport_width: readNumber('min_viewport_width'),
    icons: hasIcons || undefined,
    iconsRaw,
  };
}

/** Returns the literal source of the `icons: [ ... ]` array including
 * surrounding brackets, or undefined if no such array is found. Balances
 * brackets and respects strings so a `]` inside a value isn't counted. */
function extractIconsArray(block: string): string | undefined {
  const m = block.match(/(?:^|[\s,])icons\s*:\s*\[/);
  if (!m || m.index === undefined) return undefined;
  const openIdx = block.indexOf('[', m.index);
  if (openIdx < 0) return undefined;
  const closeIdx = matchingClose(block, openIdx, '[', ']');
  if (closeIdx >= 0) return block.slice(openIdx, closeIdx + 1);
  return undefined;
}

/**
 * The index of the bracket that closes the one at `openIdx`, or -1. Quote-aware:
 * a bracket inside a '…', "…" or `…` string is not counted, and a backslash
 * escapes the next character (inside a string or not). Shared by the manifest
 * object and its icons array (#430).
 */
function matchingClose(text: string, openIdx: number, open: string, close: string): number {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let escaped = false;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
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
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
