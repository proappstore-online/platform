/**
 * Deterministic app context summary — a compact snapshot of the app's structure
 * (components, data model, SDK usage, dependencies, routes) built from the
 * working tree without any LLM call. Stored on `project.app_context_summary`
 * after each green deploy; injected into Dev/QA seed messages so agents skip
 * re-reading the same files every ticket.
 *
 * Typical output: ~2-3KB of structured markdown.
 */

/** Build a deterministic app summary from the working tree. */
export function buildAppSummary(files: Map<string, string>): string {
  const sections: string[] = [];

  // 1. Component tree — scan src/**/*.tsx for export function/const names
  const components: string[] = [];
  for (const [path, content] of files) {
    if (!path.match(/^src\/.*\.tsx$/)) continue;
    const exports = content.match(/export\s+(?:default\s+)?(?:function|const)\s+(\w+)/g);
    if (exports) {
      const names = exports.map(e => e.replace(/export\s+(?:default\s+)?(?:function|const)\s+/, ''));
      components.push(`- \`${path}\`: ${names.join(', ')}`);
    }
  }
  if (components.length > 0) {
    sections.push(`## Components (${components.length} files)\n${components.join('\n')}`);
  }

  // 2. Data model — extract CREATE TABLE and app.db.migrate patterns
  const tables: string[] = [];
  const seenTables = new Set<string>();
  for (const [, content] of files) {
    const createMatches = content.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(([\s\S]+?)\)/gi);
    for (const m of createMatches) {
      const tableName = m[1]!.toLowerCase();
      if (seenTables.has(tableName)) continue;
      seenTables.add(tableName);
      const cols = m[2]!.split(',').map(c => c.trim().split(/\s+/)[0]).filter(Boolean);
      tables.push(`- \`${m[1]}\`: ${cols.join(', ')}`);
    }
  }
  if (tables.length > 0) {
    sections.push(`## Data Model\n${tables.join('\n')}`);
  }

  // 3. SDK usage — grep for app.* calls
  const sdkModules = new Set<string>();
  const sdkPattern = /app\.(auth|db|kv|rooms|counters|proxy|storage|maps|ai|notifications|sms|subscription|email|roles|log|webhooks)\b/g;
  for (const [, content] of files) {
    for (const m of content.matchAll(sdkPattern)) {
      sdkModules.add(m[1]!);
    }
  }
  if (sdkModules.size > 0) {
    sections.push(`## SDK Usage\n${[...sdkModules].sort().map(m => `- \`app.${m}\``).join('\n')}`);
  }

  // 4. Dependencies — parse package.json
  const pkgJson = files.get('package.json');
  if (pkgJson) {
    try {
      const pkg = JSON.parse(pkgJson) as { dependencies?: Record<string, string> };
      const deps = Object.keys(pkg.dependencies ?? {}).filter(d => !d.startsWith('@types/'));
      if (deps.length > 0) {
        sections.push(`## Dependencies\n${deps.map(d => `- \`${d}\``).join('\n')}`);
      }
    } catch { /* ignore malformed */ }
  }

  // 5. Routes/views — extract view state types and tab definitions
  const views: string[] = [];
  for (const [path, content] of files) {
    if (!path.match(/^src\/.*\.(ts|tsx)$/)) continue;
    // type View = 'home' | 'settings' | 'profile'
    const viewMatch = content.match(/type\s+(?:View|Page|Screen|Tab|Route)\s*=\s*([^;]+)/);
    if (viewMatch) {
      views.push(`- \`${path}\`: ${viewMatch[1]!.trim()}`);
    }
  }
  if (views.length > 0) {
    sections.push(`## Views / Routes\n${views.join('\n')}`);
  }

  if (sections.length === 0) return '';
  return `# App Context Summary\n\n${sections.join('\n\n')}`;
}
