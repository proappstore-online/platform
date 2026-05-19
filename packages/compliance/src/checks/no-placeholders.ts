import type { FileSource } from '../lib/file-source.js';
import type { CheckResult } from '../types.js';

const TEXT_EXTS = new Set([
  '.md',
  '.txt',
  '.json',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.yaml',
  '.yml',
  '.toml',
  '.svg',
]);

/**
 * Catches the case where APPNAME placeholders from the template were
 * never substituted. The CLI's `fas init` substitutes correctly today
 * but if someone clones the template manually and forgets the find/
 * replace step, every page renders with `<title>APPNAME — …</title>`.
 */
export async function checkNoPlaceholders(source: FileSource): Promise<CheckResult> {
  const offenders: string[] = [];
  for await (const path of source.list()) {
    if (!TEXT_EXTS.has(extOf(path))) continue;
    const content = await source.read(path);
    if (content?.includes('APPNAME')) {
      offenders.push(path);
      if (offenders.length >= 5) break; // don't spam, summarize
    }
  }
  if (offenders.length === 0) {
    return { name: 'No template placeholders', status: 'pass', detail: 'all APPNAME substituted' };
  }
  return {
    name: 'No template placeholders',
    status: 'fail',
    detail: `${offenders.length === 5 ? '5+' : offenders.length} file(s) still contain APPNAME: ${offenders.join(', ')}`,
    suggestions: [
      'Run `fas init <id>` instead of cloning the template manually — it does the substitution.',
      'Or do a project-wide find/replace: APPNAME → your app id (lowercase, hyphenated).',
    ],
  };
}

function extOf(path: string): string {
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  return dot > slash ? path.slice(dot).toLowerCase() : '';
}
