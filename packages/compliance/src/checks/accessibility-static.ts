import { extname } from 'node:path';
import type { FileSource } from '../lib/file-source.js';
import { stripCommentsForExt } from '../lib/strip.js';
import type { CheckResult } from '../types.js';

const SOURCE_EXTENSIONS = new Set(['.html', '.htm', '.jsx', '.tsx']);

interface Issue {
  path: string;
  line: number;
  message: string;
}

/**
 * Baseline accessibility checks that can run in `pas check` without a browser.
 * This intentionally catches obvious source-level mistakes only. Runtime WCAG
 * audits such as axe/contrast/focus order belong in VCQA/Playwright.
 */
export async function checkAccessibilityStatic(source: FileSource): Promise<CheckResult> {
  const issues: Issue[] = [];

  for await (const path of source.list()) {
    if (!isUiSource(path)) continue;
    const raw = await source.read(path);
    if (!raw) continue;
    const content = stripCommentsForExt(raw, extname(path));

    issues.push(...findImageIssues(path, content));
    issues.push(...findButtonIssues(path, content));
    issues.push(...findFormControlIssues(path, content));
  }

  if (issues.length === 0) {
    return { name: 'Accessibility static', status: 'pass', detail: 'images, buttons, and form controls have basic accessible names' };
  }

  const shown = issues.slice(0, 6).map((i) => `${i.path}:${i.line} ${i.message}`);
  return {
    name: 'Accessibility static',
    status: 'fail',
    detail: `${issues.length} accessibility issue(s): ${shown.join('; ')}${issues.length > shown.length ? '; ...' : ''}`,
    suggestions: [
      'Add `alt` to every `<img>`; use `alt=""` only for decorative images.',
      'Give icon-only buttons an accessible name with `aria-label`, `aria-labelledby`, or visible text.',
      'Associate inputs, textareas, and selects with a `<label htmlFor>` or an `aria-label` / `aria-labelledby`.',
    ],
  };
}

function isUiSource(path: string): boolean {
  if (!(path === 'web/index.html' || path.startsWith('web/src/'))) return false;
  return SOURCE_EXTENSIONS.has(extname(path).toLowerCase());
}

function findImageIssues(path: string, content: string): Issue[] {
  const issues: Issue[] = [];
  for (const match of content.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    if (hasAttr(tag, 'alt') || hasAttrValue(tag, 'role', /^(presentation|none)$/i) || hasAttrValue(tag, 'aria-hidden', /^true$/i)) {
      continue;
    }
    issues.push({ path, line: lineFor(content, match.index ?? 0), message: '<img> is missing alt text' });
  }
  return issues;
}

/** A button's accessible label lives right at the open tag; only this much body is inspected. */
const BUTTON_BODY_WINDOW = 2048;
/** Hard cap on buttons scanned per file — a real component has dozens; stops any DoS dead. */
const MAX_BUTTONS_PER_FILE = 2000;

function findButtonIssues(path: string, content: string): Issue[] {
  const issues: Issue[] = [];
  let seen = 0;
  // SECURITY: scan `<button …>` OPEN tags with a LINEAR regex, then inspect only
  // a bounded window of body for each. A paired-tag regex (`<button>…</button>`)
  // is O(n²) on a file full of unclosed `<button>` tags — every open position
  // re-scans the whole tail for a close that never comes (ReDoS → provision
  // Worker DoS). This bounded scan is O(n).
  const open = /<button\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = open.exec(content)) !== null) {
    if (++seen > MAX_BUTTONS_PER_FILE) break;
    const attrs = match[1] ?? '';
    const win = content.slice(open.lastIndex, open.lastIndex + BUTTON_BODY_WINDOW);
    const closeIdx = win.indexOf('</button>');
    const body = closeIdx >= 0 ? win.slice(0, closeIdx) : win;
    if (hasAnyAccessibleName(attrs, body)) continue;
    issues.push({ path, line: lineFor(content, match.index), message: '<button> has no accessible name' });
  }
  return issues;
}

function findFormControlIssues(path: string, content: string): Issue[] {
  const issues: Issue[] = [];
  for (const match of content.matchAll(/<(input|textarea|select)\b[^>]*>/gi)) {
    const tag = match[0];
    const name = match[1]!.toLowerCase();
    if (name === 'input' && hasAttrValue(tag, 'type', /^(hidden|submit|button|reset|checkbox|radio)$/i)) continue;
    if (hasAttr(tag, 'aria-label') || hasAttr(tag, 'aria-labelledby')) continue;

    const id = attrValue(tag, 'id');
    if (id && hasLabelFor(content, id)) continue;
    if (isInsideLabel(content, match.index ?? 0)) continue;

    issues.push({ path, line: lineFor(content, match.index ?? 0), message: `<${name}> is missing an accessible label` });
  }
  return issues;
}

function hasAnyAccessibleName(attrs: string, body: string): boolean {
  if (hasAttr(attrs, 'aria-label') || hasAttr(attrs, 'aria-labelledby') || hasAttr(attrs, 'title')) return true;
  const text = body
    .replace(/<[^>]+>/g, ' ')
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 0;
}

function hasAttr(tag: string, attr: string): boolean {
  return new RegExp(`\\b${escapeRegExp(attr)}\\s*=`, 'i').test(tag);
}

function hasAttrValue(tag: string, attr: string, value: RegExp): boolean {
  const found = attrValue(tag, attr);
  return found !== null && value.test(found);
}

function attrValue(tag: string, attr: string): string | null {
  const match = new RegExp(`\\b${escapeRegExp(attr)}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|\\{["']([^"']*)["']\\})`, 'i').exec(tag);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function hasLabelFor(content: string, id: string): boolean {
  const escaped = escapeRegExp(id);
  return new RegExp(`<label\\b[^>]*(?:htmlFor|for)\\s*=\\s*(?:"${escaped}"|'${escaped}'|\\{["']${escaped}["']\\})`, 'i').test(content);
}

function isInsideLabel(content: string, index: number): boolean {
  const before = content.slice(Math.max(0, index - 700), index);
  const lastOpen = before.lastIndexOf('<label');
  const lastClose = before.lastIndexOf('</label>');
  return lastOpen !== -1 && lastOpen > lastClose;
}

function lineFor(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
