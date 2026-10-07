/** Lowercased extension of a path, including the dot (`.tsx`), or '' when none. */
export function extOf(path: string): string {
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  return dot > slash ? path.slice(dot).toLowerCase() : '';
}

/** 1-based line number of `index` within `content`. */
export function lineNumberAt(content: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index; i++) if (content.charCodeAt(i) === 10) n++;
  return n;
}

/** `value` with every RegExp metacharacter escaped, for embedding in a pattern. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
