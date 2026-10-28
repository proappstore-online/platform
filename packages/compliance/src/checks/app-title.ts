import type { FileSource } from '../lib/file-source.js';
import { stripHtmlComments } from '../lib/strip.js';
import type { CheckResult } from '../types.js';

const HTML_PATH = 'web/index.html';

/** The app id: `.pas.json` `appId`, else the root package.json `name` with any scope stripped. */
async function appIdOf(source: FileSource): Promise<string | null> {
  for (const [path, key] of [['.pas.json', 'appId'], ['package.json', 'name']] as const) {
    const text = await source.read(path);
    if (!text) continue;
    try {
      const value = (JSON.parse(text) as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.trim()) return value.replace(/^@[^/]+\//, '').trim();
    } catch {
      // unreadable: try the next source
    }
  }
  return null;
}

/**
 * #499: the `<title>` is what the tab, history and search results show. The template ships
 * `<title>APPNAME</title>` and scaffolding used to leave the slug there, so an app served
 * `<title>bookkeeper</title>`. Warns when the title is still `APPNAME` or is exactly the app's id.
 * A warning: the app works. `pas create` now writes the display name ("Door Drop"), so this
 * catches apps scaffolded before, or edited back.
 */
export async function checkAppTitle(source: FileSource): Promise<CheckResult> {
  const name = 'App title';
  const raw = await source.read(HTML_PATH);
  if (raw === null) return { name, status: 'pass', detail: `${HTML_PATH} not found; html-meta reports it` };
  const match = stripHtmlComments(raw).match(/<title>([\s\S]*?)<\/title>/i);
  const title = match?.[1]?.replace(/\s+/g, ' ').trim() ?? '';
  if (title === '') return { name, status: 'pass', detail: 'no title; html-meta reports it' };
  const id = await appIdOf(source);
  if (/^APPNAME$/i.test(title) || (id !== null && title === id)) {
    return {
      name,
      status: 'warn',
      detail: `<title>${title}</title> is ${/^APPNAME$/i.test(title) ? 'the template placeholder' : "the app's id"}, not a display name`,
      suggestions: [`Set the <title> in ${HTML_PATH} (and the og:title / twitter:title metas) to the app's display name, e.g. "Door Drop" for door-drop.`],
    };
  }
  return { name, status: 'pass', detail: `<title>${title}</title>` };
}
