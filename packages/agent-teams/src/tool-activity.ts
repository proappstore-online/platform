/**
 * Human-readable one-liner for a tool call in the activity trail — surfaces the
 * salient argument (file path, search query, files written) so the log reads
 * "Dev: read_file src/index.ts" instead of a bare "Dev: read_file".
 */
export function toolActivityDetail(name: string, args: unknown): string {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  const path = typeof a.path === 'string' ? a.path : undefined;
  const query = typeof a.query === 'string' ? a.query : undefined;
  switch (name) {
    case 'read_file':
    case 'write_file':
      return path ? `${name} ${path}` : name;
    case 'list_files':
      return path ? `list_files ${path}` : 'list_files';
    case 'search_files':
      return query ? `search_files "${query}"` : 'search_files';
    case 'batch_write_files': {
      const files = Array.isArray(a.files) ? a.files : [];
      const names = files
        .map((f) => (f && typeof f === 'object' && typeof (f as Record<string, unknown>).path === 'string' ? (f as Record<string, unknown>).path as string : null))
        .filter((p): p is string => !!p);
      if (!names.length) return 'batch_write_files';
      return `batch_write_files (${names.length}): ${names.slice(0, 4).join(', ')}${names.length > 4 ? ', …' : ''}`;
    }
    case 'scaffold_app':
      return typeof a.template === 'string' ? `scaffold_app ${a.template}` : 'scaffold_app';
    default:
      return path ? `${name} ${path}` : query ? `${name} "${query}"` : name;
  }
}
